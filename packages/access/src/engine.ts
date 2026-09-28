import { randomUUID } from "node:crypto";
import type { DbClient } from "@access/db";
import { recordWhatsAppConsent } from "@access/notifications";
import {
  createPatient,
  patientsByPhone,
  type IdentifierHasher,
} from "@access/patients";
import {
  SchedulingError,
  cancelAppointment,
  confirmHold,
  createHold,
  getPracticeSettings,
  listAppointmentTypes,
  listAppointments,
  queryAvailability,
  releaseHold,
  schedulingErrorFromDatabase,
  type CommandContext,
} from "@access/scheduling";
import {
  interpret,
  parseDateOfBirth,
  parseFullName,
  type Intent,
} from "./interpreter.js";
import {
  EXPIRED_OPTION,
  OPTED_IN,
  OPTED_OUT,
  UNSUPPORTED,
  emergency,
  handoff as handoffReply,
  longWhen,
  menu,
  slotTitle,
  text,
  type OutboundMessage,
} from "./replies.js";

/**
 * The access layer's conversation engine. One inbound message is handled per
 * call, inside the worker's transaction for that message; every scheduling
 * action goes through the Scheduling Core with the patient as actor and the
 * conversation as the hold's session. The engine never invents availability
 * (slots come from the Core), never acts on an option it did not offer in
 * this conversation, and never books, moves or cancels without an explicit
 * confirmation of the exact slot or appointment shown.
 */
export type NeedsStaffReason =
  | "PATIENT_REQUESTED_STAFF"
  | "SAFETY_CONCERN"
  | "NOT_UNDERSTOOD"
  | "IDENTITY_UNCLEAR"
  | "BOOKING_FAILED";
export interface ConversationRow {
  tenant_id: string;
  practice_id: string;
  id: string;
  connection_id: string;
  participant_address: string;
  patient_id: string | null;
  status: "ACTIVE" | "NEEDS_STAFF" | "CLOSED";
  needs_staff_reason: NeedsStaffReason | null;
  state: string;
  state_data: StateData;
  state_expires_at: Date | null;
  version: number;
}
export interface InboundMessageRow {
  id: string;
  message_type:
    "TEXT" | "BUTTON_REPLY" | "LIST_REPLY" | "INTERACTIVE" | "UNSUPPORTED";
  body: string | null;
  payload: { reply_id?: string | null } | null;
  correlation_id: string;
}
/** Optional free-text understanding (e.g. an LLM); never decides actions. */
export interface IntentClassifier {
  classify(text: string): Promise<Intent | null>;
}
export interface EngineOptions {
  hasher: IdentifierHasher;
  now: () => Date;
  classifier?: IntentClassifier;
  /** Days per availability search page. */
  searchDays: number;
  /** Pages searched before reporting no availability. */
  maxSearchPages: number;
}

type State =
  | "IDLE"
  | "IDENTIFY_WHO"
  | "REGISTER_NAME"
  | "REGISTER_DOB"
  | "REGISTER_CONSENT"
  | "CHOOSE_TYPE"
  | "CHOOSE_SLOT"
  | "CONFIRM_HOLD"
  | "CHOOSE_APPOINTMENT"
  | "APPOINTMENT_ACTIONS"
  | "CONFIRM_CANCEL";
type Goal = "BOOK" | "LIST" | "CANCEL" | "RESCHEDULE";
interface SlotOption {
  start: string;
  practitionerId: string;
  locationId: string;
  title: string;
  detail: string;
  timezone: string;
}
export interface StateData {
  goal?: Goal;
  candidates?: { id: string; label: string }[];
  registration?: { givenName: string; familyName: string };
  attempts?: number;
  typeOptions?: { id: string; label: string }[];
  typeId?: string;
  slots?: SlotOption[];
  searchFrom?: string;
  holdId?: string;
  rescheduleOfId?: string;
  appointments?: { id: string; label: string; typeId: string }[];
  appointmentId?: string;
  misunderstood?: number;
}
/** A conversation left mid-flow resets after this long. */
const STATE_TTL_MS = 30 * 60_000;
/** What a classifier may turn free text into. */
const CLASSIFIABLE: ReadonlySet<Intent["kind"]> = new Set([
  "BOOK",
  "LIST",
  "CANCEL",
  "RESCHEDULE",
  "HANDOFF",
  "SAFETY",
  "MENU",
]);

type CoreResult<T> = { ok: true; value: T } | { ok: false; code: string };

export async function handleInboundMessage(
  c: DbClient,
  conversation: ConversationRow,
  message: InboundMessageRow,
  options: EngineOptions,
): Promise<OutboundMessage[]> {
  const turn = new Turn(c, conversation, message, options);
  await turn.run();
  await turn.persist();
  return turn.replies;
}

class Turn {
  readonly replies: OutboundMessage[] = [];
  private state: State;
  private data: StateData;
  private status: ConversationRow["status"];
  private reason: NeedsStaffReason | null;
  private patientId: string | null;
  private practice: {
    name: string;
    contact_phone: string | null;
    hold_ttl_seconds: number;
  } | null = null;
  private readonly now: Date;

  constructor(
    private readonly c: DbClient,
    private readonly conv: ConversationRow,
    private readonly msg: InboundMessageRow,
    private readonly options: EngineOptions,
  ) {
    this.state = (conv.state as State) ?? "IDLE";
    this.data = { ...(conv.state_data ?? {}) };
    this.status = conv.status;
    this.reason = conv.needs_staff_reason;
    this.patientId = conv.patient_id;
    this.now = options.now();
  }

  // ---------------------------------------------------------------------
  // Plumbing
  // ---------------------------------------------------------------------

  private get scope() {
    return { tenantId: this.conv.tenant_id, practiceId: this.conv.practice_id };
  }
  private ctx(patientId: string | null): CommandContext {
    return {
      ...this.scope,
      actor: patientId
        ? { type: "PATIENT", id: `patient:${patientId}`, role: null }
        : { type: "PATIENT", id: `conversation:${this.conv.id}`, role: null },
      channel: "WHATSAPP",
      correlationId: this.msg.correlation_id,
      sessionRef: `whatsapp:${this.conv.id}`,
    };
  }
  private async practiceInfo() {
    if (!this.practice) {
      const p = await getPracticeSettings(this.c, this.scope);
      this.practice = {
        name: p.name,
        contact_phone: p.contact_phone,
        hold_ttl_seconds: p.hold_ttl_seconds,
      };
    }
    return this.practice!;
  }
  private say(message: OutboundMessage) {
    this.replies.push(message);
  }
  private goIdle() {
    this.state = "IDLE";
    this.data = {};
  }
  /** Run a Scheduling Core command; domain refusals come back as codes. */
  private async core<T>(fn: () => Promise<T>): Promise<CoreResult<T>> {
    await this.c.query("SAVEPOINT access_command");
    try {
      const value = await fn();
      await this.c.query("RELEASE SAVEPOINT access_command");
      return { ok: true, value };
    } catch (e) {
      await this.c.query("ROLLBACK TO SAVEPOINT access_command");
      const domain =
        e instanceof SchedulingError ? e : schedulingErrorFromDatabase(e);
      if (domain) return { ok: false, code: domain.code };
      throw e;
    }
  }

  // ---------------------------------------------------------------------
  // Turn
  // ---------------------------------------------------------------------

  async run(): Promise<void> {
    if (
      this.state !== "IDLE" &&
      this.conv.state_expires_at &&
      +this.conv.state_expires_at < +this.now
    ) {
      await this.abandon();
    }
    let intent = interpret({
      kind:
        this.msg.message_type === "INTERACTIVE"
          ? "TEXT"
          : this.msg.message_type,
      text: this.msg.body,
      replyId: this.msg.payload?.reply_id ?? null,
    });
    if (
      intent.kind === "TEXT" &&
      this.state === "IDLE" &&
      this.status !== "NEEDS_STAFF" &&
      this.options.classifier
    )
      intent = await this.classified(intent);

    if (intent.kind === "SAFETY") return this.safety();
    if (intent.kind === "UNSUPPORTED") return this.say(UNSUPPORTED);
    if (intent.kind === "OPT_OUT") return this.consent(false);
    if (intent.kind === "OPT_IN") return this.consent(true);
    const wantsMenu = intent.kind === "MENU" || isChoice(intent, "M:MENU");
    if (this.status === "NEEDS_STAFF") {
      // A person is handling this conversation: stay quiet unless the
      // patient asks for the menu, which hands it back to the assistant.
      if (!wantsMenu) return;
      this.status = "ACTIVE";
      this.reason = null;
    }
    // A closed conversation reopens with the patient's next message.
    if (this.status === "CLOSED") this.status = "ACTIVE";
    if (wantsMenu || intent.kind === "GREETING") {
      await this.abandon();
      return this.showMenu();
    }
    if (intent.kind === "HANDOFF" || isChoice(intent, "M:STAFF"))
      return this.handoff("PATIENT_REQUESTED_STAFF");

    switch (this.state) {
      case "IDLE":
        return this.idle(intent);
      case "IDENTIFY_WHO":
        return this.chooseWho(intent);
      case "REGISTER_NAME":
        return this.registerName(intent);
      case "REGISTER_DOB":
        return this.registerDob(intent);
      case "REGISTER_CONSENT":
        return this.registerConsent(intent);
      case "CHOOSE_TYPE":
        return this.chooseType(intent);
      case "CHOOSE_SLOT":
        return this.chooseSlot(intent);
      case "CONFIRM_HOLD":
        return this.confirmHeld(intent);
      case "CHOOSE_APPOINTMENT":
        return this.chooseAppointment(intent);
      case "APPOINTMENT_ACTIONS":
        return this.appointmentAction(intent);
      case "CONFIRM_CANCEL":
        return this.confirmCancel(intent);
      default:
        this.goIdle();
        return this.showMenu();
    }
  }

  async persist(): Promise<void> {
    const expires =
      this.state === "IDLE" ? null : new Date(+this.now + STATE_TTL_MS);
    await this.c.query(
      `UPDATE messaging.channel_conversations
          SET state=$4, state_data=$5, state_expires_at=$6, status=$7, needs_staff_reason=$8, patient_id=$9,
              version=version+1, updated_at=now()
        WHERE tenant_id=$1 AND practice_id=$2 AND id=$3`,
      [
        this.conv.tenant_id,
        this.conv.practice_id,
        this.conv.id,
        this.state,
        JSON.stringify(this.data),
        expires,
        this.status,
        this.status === "NEEDS_STAFF" ? this.reason : null,
        this.patientId,
      ],
    );
    for (const reply of this.replies)
      await this.c.query(
        `INSERT INTO messaging.channel_messages(tenant_id, practice_id, id, conversation_id, direction, provider, message_type,
            body, payload, status, sent_by, next_attempt_at, correlation_id)
         VALUES($1,$2,$3,$4,'OUTBOUND','WHATSAPP_CLOUD',$5,$6,$7,'PENDING','system:access-layer',now(),$8)`,
        [
          this.conv.tenant_id,
          this.conv.practice_id,
          randomUUID(),
          this.conv.id,
          reply.kind === "text" ? "TEXT" : "INTERACTIVE",
          reply.body,
          JSON.stringify(
            reply.kind === "buttons"
              ? { kind: "buttons", buttons: reply.buttons }
              : reply.kind === "list"
                ? {
                    kind: "list",
                    button: reply.button,
                    section: reply.section,
                    rows: reply.rows,
                  }
                : { kind: "text" },
          ),
          this.msg.correlation_id,
        ],
      );
    await this.c.query(
      `UPDATE messaging.channel_messages SET status='PROCESSED', processed_at=now(), lease_until=NULL
        WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 AND status IN ('RECEIVED','PROCESSING')`,
      [this.conv.tenant_id, this.conv.practice_id, this.msg.id],
    );
  }

  /**
   * Free text through the optional classifier. Only intents that start a
   * flow or escalate are accepted - never a choice, a number or a yes that
   * could confirm something - and a failing classifier is ignored.
   */
  private async classified(
    intent: Extract<Intent, { kind: "TEXT" }>,
  ): Promise<Intent> {
    const result = await this.options
      .classifier!.classify(intent.text)
      .catch(() => null);
    return result && CLASSIFIABLE.has(result.kind) ? result : intent;
  }

  // ---------------------------------------------------------------------
  // Global actions
  // ---------------------------------------------------------------------

  private async showMenu(intro?: string) {
    const p = await this.practiceInfo();
    this.say(menu(p.name, intro));
  }
  private async handoff(reason: NeedsStaffReason, message?: string) {
    await this.abandon();
    this.status = "NEEDS_STAFF";
    this.reason = reason;
    const p = await this.practiceInfo();
    if (message) this.say(text(message));
    this.say(handoffReply(p.contact_phone));
  }
  private async safety() {
    await this.abandon();
    this.status = "NEEDS_STAFF";
    this.reason = "SAFETY_CONCERN";
    const p = await this.practiceInfo();
    this.say(emergency(p.contact_phone));
  }
  /**
   * STOP applies to the number: every patient registered with it (family
   * members may share one) stops receiving WhatsApp messages. Opting back in
   * needs one known patient, so nobody is opted in on someone else's behalf.
   */
  private async consent(optIn: boolean) {
    const matches = this.patientId
      ? [this.patientId]
      : (
          await patientsByPhone(
            this.c,
            this.scope,
            this.conv.participant_address,
          )
        ).map((p) => p.id);
    if (optIn && matches.length !== 1) {
      this.say(
        text(
          "Please choose Book appointment first, or ask reception to turn reminders on for you.",
        ),
      );
      return;
    }
    for (const patientId of optIn ? matches.slice(0, 1) : matches)
      await recordWhatsAppConsent(
        this.c,
        { ...this.scope, actor: this.ctx(patientId).actor },
        patientId,
        optIn,
      );
    this.say(optIn ? OPTED_IN : OPTED_OUT);
  }
  /** Leave the current flow, releasing a hold we still own. */
  private async abandon() {
    if (this.data.holdId && this.patientId) {
      const holdId = this.data.holdId;
      await this.core(() =>
        releaseHold(this.c, this.ctx(this.patientId), holdId),
      );
    }
    this.goIdle();
  }
  private async misunderstood() {
    const count = (this.data.misunderstood ?? 0) + 1;
    if (count >= 3)
      return this.handoff(
        "NOT_UNDERSTOOD",
        "Sorry, I'm having trouble understanding.",
      );
    this.data.misunderstood = count;
    await this.showMenu(
      "Sorry, I didn't understand that. Please choose an option below, or type MENU at any time.",
    );
  }

  // ---------------------------------------------------------------------
  // Identification and registration
  // ---------------------------------------------------------------------

  private async idle(intent: Intent) {
    const goal: Goal | null =
      intent.kind === "BOOK" ||
      isChoice(intent, "M:BOOK") ||
      isNumber(intent, 1)
        ? "BOOK"
        : intent.kind === "LIST" ||
            isChoice(intent, "M:LIST") ||
            isNumber(intent, 2)
          ? "LIST"
          : intent.kind === "CANCEL"
            ? "CANCEL"
            : intent.kind === "RESCHEDULE"
              ? "RESCHEDULE"
              : null;
    if (!goal) {
      if (intent.kind === "CHOICE")
        return this.showMenu(`${EXPIRED_OPTION} What would you like to do?`);
      return this.misunderstood();
    }
    this.data = { goal };
    const patient = await this.identify();
    if (patient) await this.pursue();
  }

  /** The patient this conversation acts for, or start finding out. */
  private async identify(): Promise<string | null> {
    if (this.patientId) {
      const r = await this.c.query(
        "SELECT 1 FROM directory.patients WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 AND status='ACTIVE'",
        [this.scope.tenantId, this.scope.practiceId, this.patientId],
      );
      if (r.rowCount) return this.patientId;
      this.patientId = null;
    }
    const matches = await patientsByPhone(
      this.c,
      this.scope,
      this.conv.participant_address,
    );
    if (matches.length === 1) {
      await this.link(matches[0]!.id);
      return this.patientId;
    }
    if (matches.length > 1) {
      // Family members may share a number: ask who, by first name only.
      this.data.candidates = matches.slice(0, 9).map((p) => ({
        id: p.id,
        label: p.preferred_name ?? p.given_name,
      }));
      this.state = "IDENTIFY_WHO";
      this.say({
        kind: "list",
        body: "Who is this for?",
        button: "Choose",
        section: "Patients",
        rows: this.data.candidates.map((p, i) => ({
          id: `W:${i + 1}`,
          title: p.label,
        })),
      });
      return null;
    }
    if (this.data.goal !== "BOOK") {
      this.goIdle();
      await this.showMenu(
        "We could not find any appointments for this number. You can book one below.",
      );
      return null;
    }
    this.state = "REGISTER_NAME";
    this.say(
      text(
        "Welcome! We don't have this number on record yet. Please send the patient's first name and surname (for example: Thandi Mokoena).",
      ),
    );
    return null;
  }
  private async link(patientId: string) {
    this.patientId = patientId;
    // Writing from this number shows it is the patient's WhatsApp number.
    await this.c.query(
      `UPDATE directory.patient_contacts
          SET whatsapp_capable=true, verified_at=coalesce(verified_at, now()),
              verification_method=coalesce(verification_method, 'WHATSAPP_INBOUND')
        WHERE tenant_id=$1 AND practice_id=$2 AND patient_id=$3 AND kind='MOBILE' AND value=$4 AND removed_at IS NULL
          AND (NOT whatsapp_capable OR verified_at IS NULL)`,
      [
        this.scope.tenantId,
        this.scope.practiceId,
        patientId,
        this.conv.participant_address,
      ],
    );
  }
  private async chooseWho(intent: Intent) {
    const index = optionIndex(intent, "W:");
    const who = index !== null ? this.data.candidates?.[index] : undefined;
    if (!who) {
      if (this.bumpAttempts() > 3) return this.handoff("IDENTITY_UNCLEAR");
      return this.say(text("Please choose one of the names in the list."));
    }
    await this.link(who.id);
    delete this.data.candidates;
    await this.pursue();
  }
  private bumpAttempts(): number {
    this.data.attempts = (this.data.attempts ?? 0) + 1;
    return this.data.attempts;
  }
  private async registerName(intent: Intent) {
    const name = intent.kind === "TEXT" ? parseFullName(intent.text) : null;
    if (!name) {
      if (this.bumpAttempts() > 3) return this.handoff("IDENTITY_UNCLEAR");
      return this.say(
        text(
          "Please send a first name and surname, for example: Thandi Mokoena.",
        ),
      );
    }
    this.data.registration = name;
    this.data.attempts = 0;
    this.state = "REGISTER_DOB";
    this.say(
      text(
        `Thank you. What is ${name.givenName}'s date of birth? (for example 21/03/1990)`,
      ),
    );
  }
  private async registerDob(intent: Intent) {
    const dob =
      intent.kind === "TEXT" || intent.kind === "NUMBER"
        ? parseDateOfBirth(
            intent.kind === "TEXT" ? intent.text : String(intent.n),
            this.now,
          )
        : null;
    if (!dob || !this.data.registration) {
      if (this.bumpAttempts() > 3) return this.handoff("IDENTITY_UNCLEAR");
      return this.say(
        text(
          "Please send the date of birth as DD/MM/YYYY, for example 21/03/1990.",
        ),
      );
    }
    const created = await this.core(() =>
      createPatient(
        this.c,
        this.ctx(null),
        {
          givenName: this.data.registration!.givenName,
          familyName: this.data.registration!.familyName,
          dateOfBirth: dob,
          sourceChannel: "WHATSAPP",
          identityVerification: "UNVERIFIED",
          contacts: [
            {
              kind: "MOBILE",
              value: this.conv.participant_address,
              whatsappCapable: true,
              verifiedVia: "WHATSAPP_INBOUND",
            },
          ],
        },
        this.options.hasher,
      ),
    );
    if (!created.ok) return this.handoff("IDENTITY_UNCLEAR");
    this.patientId = created.value.patient.id;
    delete this.data.registration;
    this.data.attempts = 0;
    this.state = "REGISTER_CONSENT";
    this.say({
      kind: "buttons",
      body: "You're registered. May we send appointment confirmations and reminders to this WhatsApp number?",
      buttons: [
        { id: "R:YES", title: "Yes please" },
        { id: "R:NO", title: "No thanks" },
      ],
    });
  }
  private async registerConsent(intent: Intent) {
    const yes = intent.kind === "YES" || isChoice(intent, "R:YES");
    const no = intent.kind === "NO" || isChoice(intent, "R:NO");
    if (!yes && !no)
      return this.say(
        text("Please reply YES or NO: may we send reminders here?"),
      );
    if (yes)
      await recordWhatsAppConsent(
        this.c,
        { ...this.scope, actor: this.ctx(this.patientId).actor },
        this.patientId!,
        true,
      );
    await this.pursue();
  }

  /** Continue towards the goal once the patient is known. */
  private async pursue() {
    const goal = this.data.goal ?? "BOOK";
    if (goal === "BOOK") return this.chooseTypeOrSlots();
    return this.showAppointments(goal);
  }

  // ---------------------------------------------------------------------
  // Booking
  // ---------------------------------------------------------------------

  private async bookableTypes(): Promise<{ id: string; label: string }[]> {
    const types = (await listAppointmentTypes(this.c, this.scope)) as {
      id: string;
      name: string;
      duration_minutes: number;
      patient_bookable: boolean;
      requires_referral: boolean;
      new_patient_allowed: boolean;
      follow_up_only: boolean;
      active: boolean;
    }[];
    const history = await this.c.query<{ n: number }>(
      `SELECT count(*)::int n FROM scheduling.appointments WHERE tenant_id=$1 AND practice_id=$2 AND patient_id=$3
          AND status IN ('CONFIRMED','CHECKED_IN','IN_PROGRESS','COMPLETED')`,
      [this.scope.tenantId, this.scope.practiceId, this.patientId],
    );
    const returning = history.rows[0]!.n > 0;
    const referrals = await this.c.query<{
      appointment_type_id: string | null;
    }>(
      `SELECT appointment_type_id FROM scheduling.patient_referrals
        WHERE tenant_id=$1 AND practice_id=$2 AND patient_id=$3 AND status='VERIFIED'
          AND (valid_until IS NULL OR valid_until >= current_date)`,
      [this.scope.tenantId, this.scope.practiceId, this.patientId],
    );
    const referred = (typeId: string) =>
      referrals.rows.some(
        (r) =>
          r.appointment_type_id === null || r.appointment_type_id === typeId,
      );
    return types
      .filter(
        (t) =>
          t.active &&
          t.patient_bookable &&
          (returning || t.new_patient_allowed) &&
          (!t.follow_up_only || returning) &&
          (!t.requires_referral || referred(t.id)),
      )
      .slice(0, 10)
      .map((t) => ({ id: t.id, label: t.name }));
  }
  private async chooseTypeOrSlots() {
    const types = await this.bookableTypes();
    if (!types.length)
      return this.handoff(
        "BOOKING_FAILED",
        "Online booking isn't available for this patient yet.",
      );
    if (types.length === 1) {
      this.data.typeId = types[0]!.id;
      return this.offerSlots(true);
    }
    this.data.typeOptions = types;
    this.state = "CHOOSE_TYPE";
    this.say({
      kind: "list",
      body: "What kind of appointment is this?",
      button: "Choose",
      section: "Appointment types",
      rows: types.map((t, i) => ({ id: `T:${i + 1}`, title: t.label })),
    });
  }
  private async chooseType(intent: Intent) {
    const index = optionIndex(intent, "T:");
    const type = index !== null ? this.data.typeOptions?.[index] : undefined;
    if (!type)
      return this.say(text("Please choose an appointment type from the list."));
    this.data.typeId = type.id;
    delete this.data.typeOptions;
    await this.offerSlots(true);
  }
  /** Offer the next available times - always straight from the Core. */
  private async offerSlots(fresh: boolean, prefix?: string) {
    const ctx = this.ctx(this.patientId);
    let from =
      fresh || !this.data.searchFrom
        ? this.now
        : new Date(this.data.searchFrom);
    let found: SlotOption[] = [];
    for (
      let page = 0;
      page < this.options.maxSearchPages && !found.length;
      page++
    ) {
      const to = new Date(+from + this.options.searchDays * 86_400_000);
      const result = await this.core(() =>
        queryAvailability(this.c, ctx, {
          appointmentTypeId: this.data.typeId!,
          from,
          to,
          limit: 9,
        }),
      );
      if (!result.ok)
        return this.handoff(
          "BOOKING_FAILED",
          "Online booking isn't available for this appointment type.",
        );
      found = result.value.map((s) => ({
        start: s.start,
        practitionerId: s.practitioner_id,
        locationId: s.location_id,
        title: slotTitle(new Date(s.start), s.timezone),
        detail: `${s.practitioner_name} · ${s.location_name}`,
        timezone: s.timezone,
      }));
      if (!found.length) from = to;
    }
    if (!found.length) {
      this.goIdle();
      return this.showMenu(
        `${prefix ? `${prefix} ` : ""}There are no appointments available online in the coming weeks. Choose Talk to reception and we will help you.`,
      );
    }
    this.data.slots = found;
    this.data.searchFrom = new Date(
      +new Date(found[found.length - 1]!.start) + 60_000,
    ).toISOString();
    this.state = "CHOOSE_SLOT";
    this.say({
      kind: "list",
      body: `${prefix ? `${prefix} ` : ""}These times are available. Choose one and I'll reserve it for you.`,
      button: "Choose a time",
      section: "Available times",
      rows: [
        ...found.map((s, i) => ({
          id: `S:${i + 1}`,
          title: s.title,
          description: s.detail,
        })),
        ...(found.length === 9
          ? [
              {
                id: "S:MORE",
                title: "Later times",
                description: "Show more options",
              },
            ]
          : []),
      ],
    });
  }
  private async chooseSlot(intent: Intent) {
    if (intent.kind === "MORE" || isChoice(intent, "S:MORE"))
      return this.offerSlots(false);
    const index = optionIndex(intent, "S:");
    const slot = index !== null ? this.data.slots?.[index] : undefined;
    if (!slot)
      return this.say(
        text("Please choose one of the times in the list, or type MENU."),
      );
    const hold = await this.core(() =>
      createHold(this.c, this.ctx(this.patientId), {
        patientId: this.patientId!,
        appointmentTypeId: this.data.typeId!,
        practitionerId: slot.practitionerId,
        locationId: slot.locationId,
        start: new Date(slot.start),
        ...(this.data.rescheduleOfId
          ? {
              purpose: "RESCHEDULE" as const,
              rescheduleOfId: this.data.rescheduleOfId,
            }
          : {}),
      }),
    );
    if (!hold.ok) {
      if (hold.code === "SLOT_UNAVAILABLE")
        return this.offerSlots(true, "Sorry, that time was just taken.");
      if (hold.code === "PATIENT_CHANGE_CUTOFF") return this.tooLateToChange();
      return this.handoff(
        "BOOKING_FAILED",
        "Sorry, I couldn't reserve that time.",
      );
    }
    this.data.holdId = hold.value.holdId;
    this.data.slots = [slot];
    const minutes = Math.max(
      1,
      Math.round((+hold.value.expiresAt - +this.now) / 60_000),
    );
    this.state = "CONFIRM_HOLD";
    this.say({
      kind: "buttons",
      body: `I've reserved ${longWhen(new Date(slot.start), slot.timezone)} with ${slot.detail} for the next ${minutes} minutes. Shall I confirm it?`,
      buttons: [
        { id: "H:YES", title: "Confirm" },
        { id: "H:NO", title: "Other times" },
      ],
    });
  }
  private async confirmHeld(intent: Intent) {
    const holdId = this.data.holdId;
    const slot = this.data.slots?.[0];
    if (!holdId || !slot) {
      this.goIdle();
      return this.showMenu();
    }
    if (intent.kind === "NO" || isChoice(intent, "H:NO")) {
      await this.core(() =>
        releaseHold(this.c, this.ctx(this.patientId), holdId),
      );
      delete this.data.holdId;
      return this.offerSlots(true);
    }
    if (!(intent.kind === "YES" || isChoice(intent, "H:YES")))
      return this.say({
        kind: "buttons",
        body: "Shall I confirm this appointment?",
        buttons: [
          { id: "H:YES", title: "Confirm" },
          { id: "H:NO", title: "Other times" },
        ],
      });
    const booked = await this.core(() =>
      confirmHold(this.c, this.ctx(this.patientId), holdId),
    );
    if (!booked.ok) {
      delete this.data.holdId;
      if (booked.code === "HOLD_EXPIRED" || booked.code === "HOLD_NOT_ACTIVE")
        return this.offerSlots(
          true,
          "Sorry, the reservation expired before it was confirmed.",
        );
      if (booked.code === "PATIENT_CHANGE_CUTOFF")
        return this.tooLateToChange();
      return this.handoff(
        "BOOKING_FAILED",
        "Sorry, I couldn't confirm that appointment.",
      );
    }
    const moved = Boolean(this.data.rescheduleOfId);
    this.goIdle();
    this.say(
      text(
        `${moved ? "Done - your appointment has moved to" : "You're booked for"} ${longWhen(new Date(slot.start), slot.timezone)} with ${slot.detail}. ` +
          "Reply MENU to see your appointments, or to cancel or reschedule.",
      ),
    );
  }
  private async tooLateToChange() {
    const p = await this.practiceInfo();
    this.goIdle();
    this.say(
      text(
        `It's too close to the appointment to change it here${p.contact_phone ? ` - please call us on ${p.contact_phone}` : " - please call the practice"}.`,
      ),
    );
  }

  // ---------------------------------------------------------------------
  // Existing appointments: view, cancel, reschedule
  // ---------------------------------------------------------------------

  private async showAppointments(goal: Goal) {
    const upcoming = await listAppointments(this.c, this.scope, {
      patientId: this.patientId!,
      from: this.now,
      statuses: ["CONFIRMED"],
      limit: 9,
    });
    const items = upcoming.items.map((a) => ({
      id: a.id,
      typeId: a.appointment_type.id,
      label: `${slotTitle(new Date(a.starts_at), a.timezone)} · ${a.practitioner.display_name}`,
    }));
    if (!items.length) {
      this.goIdle();
      return this.showMenu(
        "You have no upcoming appointments with us. Would you like to book one?",
      );
    }
    this.data = { goal, appointments: items };
    if (items.length === 1 && goal !== "LIST")
      return this.selectAppointment(items[0]!);
    this.state = "CHOOSE_APPOINTMENT";
    this.say({
      kind: "list",
      body:
        goal === "LIST"
          ? "Your upcoming appointments are below. Choose one to cancel or reschedule it."
          : `Which appointment would you like to ${goal === "CANCEL" ? "cancel" : "reschedule"}?`,
      button: "Appointments",
      section: "Upcoming",
      rows: items.map((a, i) => ({
        id: `A:${i + 1}`,
        title: a.label.split(" · ")[0]!,
        description: a.label.split(" · ")[1] ?? "",
      })),
    });
  }
  private async chooseAppointment(intent: Intent) {
    const index = optionIndex(intent, "A:");
    const item = index !== null ? this.data.appointments?.[index] : undefined;
    if (!item)
      return this.say(
        text("Please choose one of your appointments from the list."),
      );
    await this.selectAppointment(item);
  }
  private async selectAppointment(item: {
    id: string;
    label: string;
    typeId: string;
  }) {
    this.data.appointmentId = item.id;
    this.data.appointments = [item];
    if (this.data.goal === "CANCEL") return this.askCancel(item.label);
    if (this.data.goal === "RESCHEDULE") return this.startReschedule(item);
    this.state = "APPOINTMENT_ACTIONS";
    this.say({
      kind: "buttons",
      body: `${item.label}. What would you like to do?`,
      buttons: [
        { id: "X:CANCEL", title: "Cancel it" },
        { id: "X:MOVE", title: "Reschedule" },
        { id: "M:MENU", title: "Main menu" },
      ],
    });
  }
  private async appointmentAction(intent: Intent) {
    const item = this.data.appointments?.[0];
    if (!item) {
      this.goIdle();
      return this.showMenu();
    }
    if (isChoice(intent, "X:CANCEL") || intent.kind === "CANCEL")
      return this.askCancel(item.label);
    if (isChoice(intent, "X:MOVE") || intent.kind === "RESCHEDULE")
      return this.startReschedule(item);
    return this.selectAppointment(item);
  }
  private askCancel(label: string) {
    this.state = "CONFIRM_CANCEL";
    this.say({
      kind: "buttons",
      body: `Cancel your appointment on ${label}?`,
      buttons: [
        { id: "C:YES", title: "Yes, cancel" },
        { id: "C:NO", title: "Keep it" },
      ],
    });
  }
  private async confirmCancel(intent: Intent) {
    const id = this.data.appointmentId;
    const item = this.data.appointments?.[0];
    if (!id || !item) {
      this.goIdle();
      return this.showMenu();
    }
    if (intent.kind === "NO" || isChoice(intent, "C:NO")) {
      this.goIdle();
      return this.say(text("No problem - your appointment stays booked."));
    }
    if (!(intent.kind === "YES" || isChoice(intent, "C:YES")))
      return this.askCancel(item.label);
    const cancelled = await this.core(() =>
      cancelAppointment(this.c, this.ctx(this.patientId), id, {
        reasonCode: "PATIENT_REQUEST",
      }),
    );
    if (!cancelled.ok) {
      if (cancelled.code === "PATIENT_CHANGE_CUTOFF")
        return this.tooLateToChange();
      this.goIdle();
      return this.say(
        text(
          "That appointment can no longer be cancelled here. Reply MENU for options.",
        ),
      );
    }
    this.goIdle();
    this.say(
      text(
        `Your appointment on ${item.label} is cancelled. Reply MENU if you would like to book another time.`,
      ),
    );
  }
  private async startReschedule(item: { id: string; typeId: string }) {
    this.data = {
      goal: "RESCHEDULE",
      rescheduleOfId: item.id,
      typeId: item.typeId,
    };
    await this.offerSlots(true);
  }
}

function isChoice(intent: Intent, id: string): boolean {
  return intent.kind === "CHOICE" && intent.id === id;
}
function isNumber(intent: Intent, n: number): boolean {
  return intent.kind === "NUMBER" && intent.n === n;
}
/** Zero-based option index from "S:3" (tapped) or "3" (typed). */
function optionIndex(intent: Intent, prefix: string): number | null {
  if (intent.kind === "NUMBER") return intent.n - 1;
  if (intent.kind === "CHOICE" && intent.id.startsWith(prefix)) {
    const n = Number(intent.id.slice(prefix.length));
    return Number.isInteger(n) && n >= 1 ? n - 1 : null;
  }
  return null;
}
