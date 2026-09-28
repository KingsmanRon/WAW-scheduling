import { createHmac, randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { DateTime } from "luxon";
import pg from "pg";
import {
  API_URL,
  E2E_DATABASE_URL,
  GRAPH_URL,
  PATIENTS,
  PRACTICE_ID,
  TENANT_ID,
  WHATSAPP,
  type PatientKey,
} from "./env.js";

export type PracticeRole =
  "PRACTICE_ADMIN" | "DOCTOR" | "RECEPTIONIST" | "CLINICAL_STAFF" | "READ_ONLY";

let pool: pg.Pool | undefined;
/** The suite's database, as its owner: for assertions only, never to act. */
export function db(): pg.Pool {
  return (pool ??= new pg.Pool({ connectionString: E2E_DATABASE_URL, max: 2 }));
}
export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/** The console's synthetic sign-in (development identity bridge). */
export async function signIn(
  page: Page,
  role: PracticeRole,
  user = role.toLowerCase().replace(/_/g, "-"),
): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Organisation (tenant) ID").fill(TENANT_ID);
  await page.getByLabel("Practice role").selectOption(role);
  await page.getByLabel("Staff name (synthetic)").fill(user);
  await page.getByRole("button", { name: "Enter console" }).click();
  // One practice: straight to its day.
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
}
export function practicePath(
  view: string,
  id?: string | null,
  query?: Record<string, string>,
): string {
  const q = query ? `?${new URLSearchParams(query)}` : "";
  return `/#/p/${PRACTICE_ID}/${view}${id ? `/${id}` : ""}${q}`;
}

export async function patientId(key: PatientKey): Promise<string> {
  const rows = await db().query<{ patient_id: string }>(
    "SELECT patient_id FROM directory.patient_contacts WHERE tenant_id=$1 AND kind='MOBILE' AND value=$2",
    [TENANT_ID, PATIENTS[key].mobile],
  );
  return rows.rows[0]!.patient_id;
}
export async function practiceZone(): Promise<string> {
  const rows = await db().query<{ timezone: string }>(
    "SELECT timezone FROM directory.practices WHERE id=$1",
    [PRACTICE_ID],
  );
  return rows.rows[0]!.timezone;
}
export interface AppointmentRow {
  id: string;
  status: string;
  starts_at: Date;
  source_channel: string;
  booked_by_actor_type: string;
  booked_by_actor_id: string;
  booked_by_role: string | null;
  rescheduled_from_id: string | null;
  cancellation_reason_code: string | null;
}
export async function appointmentsOf(
  key: PatientKey,
): Promise<AppointmentRow[]> {
  const rows = await db().query<AppointmentRow>(
    `SELECT id, status, starts_at, source_channel, booked_by_actor_type, booked_by_actor_id, booked_by_role,
            rescheduled_from_id, cancellation_reason_code
       FROM scheduling.appointments WHERE tenant_id=$1 AND patient_id=$2 ORDER BY created_at`,
    [TENANT_ID, await patientId(key)],
  );
  return rows.rows;
}

/** Calls the API as a synthetic staff member (to arrange a spec's data). */
export async function api<T>(
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
  role: PracticeRole = "RECEPTIONIST",
): Promise<T> {
  const res = await fetch(`${API_URL}/v1/practices/${PRACTICE_ID}${path}`, {
    method,
    headers: {
      "x-tenant-id": TENANT_ID,
      "x-practice-role": role,
      "x-access-user": "e2e-arranger",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(method !== "GET" ? { "idempotency-key": randomUUID() } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json()) as T;
  if (!res.ok)
    throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
}
export interface Slot {
  start: string;
  practitioner_id: string;
  location_id: string;
  practitioner_name: string;
}
/** The first times the Scheduling Core offers for a type, from `hours` ahead. */
export async function freeSlots(
  typeCode: string,
  hours = 1,
  days = 3,
): Promise<{ typeId: string; slots: Slot[] }> {
  const types = await db().query<{ id: string }>(
    "SELECT id FROM scheduling.appointment_types WHERE tenant_id=$1 AND code=$2",
    [TENANT_ID, typeCode],
  );
  const typeId = types.rows[0]!.id;
  const from = new Date(Date.now() + hours * 3_600_000).toISOString();
  const to = new Date(Date.now() + days * 86_400_000).toISOString();
  const { slots } = await api<{ slots: Slot[] }>(
    "GET",
    `/availability?appointment_type_id=${typeId}&from=${from}&to=${to}&limit=400`,
  );
  return { typeId, slots };
}
/** The times offered on one practice day, optionally for one practitioner. */
export async function slotsOn(
  day: string,
  practitioner?: string,
  typeCode = "GENERAL_CONSULT",
): Promise<Slot[]> {
  const zone = await practiceZone();
  const start = DateTime.fromISO(day, { zone });
  const ids = await db().query<{ type: string; practitioner: string | null }>(
    `SELECT t.id AS type, (SELECT id FROM scheduling.practitioners WHERE tenant_id=$1 AND display_name=$3) AS practitioner
       FROM scheduling.appointment_types t WHERE t.tenant_id=$1 AND t.code=$2`,
    [TENANT_ID, typeCode, practitioner ?? ""],
  );
  const q = new URLSearchParams({
    appointment_type_id: ids.rows[0]!.type,
    from: start.toUTC().toISO()!,
    to: start.plus({ days: 1 }).toUTC().toISO()!,
    limit: "400",
    ...(practitioner ? { practitioner_id: ids.rows[0]!.practitioner! } : {}),
  });
  return (await api<{ slots: Slot[] }>("GET", `/availability?${q}`)).slots;
}
/** A date in the practice's zone, `days` from today (YYYY-MM-DD). */
export async function practiceDate(days = 0): Promise<string> {
  return DateTime.now()
    .setZone(await practiceZone())
    .plus({ days })
    .toISODate()!;
}
/**
 * Books directly through the API (as reception would), returning its id:
 * the first free time, optionally with one practitioner, on a given day
 * (days from today, practice time) and not before a local time.
 */
export async function book(
  key: PatientKey,
  options: {
    practitioner?: string;
    day?: number;
    notBefore?: string;
    typeCode?: string;
  } = {},
): Promise<{ id: string; slot: Slot }> {
  const zone = await practiceZone();
  const typeCode = options.typeCode ?? "GENERAL_CONSULT";
  const slots =
    options.day === undefined
      ? (await freeSlots(typeCode, 0, 2)).slots
      : await slotsOn(
          await practiceDate(options.day),
          options.practitioner,
          typeCode,
        );
  const typeId = (
    await db().query<{ id: string }>(
      "SELECT id FROM scheduling.appointment_types WHERE tenant_id=$1 AND code=$2",
      [TENANT_ID, typeCode],
    )
  ).rows[0]!.id;
  const slot = slots.find((s) => {
    const local = DateTime.fromISO(s.start).setZone(zone);
    return (
      (!options.practitioner || s.practitioner_name === options.practitioner) &&
      (!options.notBefore || local.toFormat("HH:mm") >= options.notBefore) &&
      Date.parse(s.start) > Date.now() + 10 * 60_000
    );
  });
  if (!slot) throw new Error("no free time matches");
  const res = await api<{ appointment: { id: string } }>(
    "POST",
    "/appointments",
    {
      patient_id: await patientId(key),
      appointment_type_id: typeId,
      practitioner_id: slot.practitioner_id,
      location_id: slot.location_id,
      start: slot.start,
      source_channel: "PHONE",
    },
  );
  return { id: res.appointment.id, slot };
}

/** A message the patient's phone received. */
export interface Reply {
  type: string;
  text: string;
  options: string[];
  template?: { name: string; payloads: string[] };
}
interface Sent {
  type: string;
  text?: { body: string };
  interactive?: {
    type: string;
    body: { text: string };
    action: {
      buttons?: { reply: { id: string } }[];
      sections?: { rows: { id: string }[] }[];
    };
  };
  template?: {
    name: string;
    components?: { type: string; parameters?: { payload?: string }[] }[];
  };
}
function replyOf(m: Sent): Reply {
  if (m.type === "text")
    return { type: "text", text: m.text?.body ?? "", options: [] };
  if (m.type === "interactive" && m.interactive) {
    const a = m.interactive.action;
    const rows =
      m.interactive.type === "button"
        ? (a.buttons ?? []).map((b) => b.reply.id)
        : (a.sections?.[0]?.rows ?? []).map((r) => r.id);
    return {
      type: m.interactive.type,
      text: m.interactive.body.text,
      options: rows,
    };
  }
  if (m.type === "template" && m.template)
    return {
      type: "template",
      text: "",
      options: [],
      template: {
        name: m.template.name,
        payloads: (m.template.components ?? [])
          .filter((c) => c.type === "button")
          .map((c) => c.parameters?.[0]?.payload ?? ""),
      },
    };
  return { type: m.type, text: "", options: [] };
}

/**
 * A patient's phone on WhatsApp: messages go to the API's webhook signed as
 * Meta signs them; replies are what the worker sent the Graph API.
 */
export class Phone {
  constructor(readonly number: string) {}
  static of(key: PatientKey): Phone {
    return new Phone(PATIENTS[key].mobile);
  }
  async replies(): Promise<Reply[]> {
    const res = await fetch(
      `${GRAPH_URL}/__fixture/messages?to=${this.number.slice(1)}`,
    );
    return ((await res.json()) as Sent[]).map(replyOf);
  }
  /** Waits for the next message the phone receives after `count` messages. */
  async next(count: number): Promise<Reply> {
    let replies: Reply[] = [];
    await expect
      .poll(
        async () => {
          replies = await this.replies();
          return replies.length;
        },
        { timeout: 20_000 },
      )
      .toBeGreaterThan(count);
    return replies[count]!;
  }
  /** The last message after the burst answering one input has arrived. */
  private async settled(count: number): Promise<Reply> {
    await this.next(count);
    let seen = -1;
    let replies: Reply[] = [];
    while (replies.length !== seen) {
      seen = replies.length;
      await new Promise((r) => setTimeout(r, 600));
      replies = await this.replies();
    }
    return replies.at(-1)!;
  }
  /** Sends a message and returns the practice's (last) answer to it. */
  async send(
    content: { text: string } | { tap: string } | { button: string },
  ): Promise<Reply> {
    const before = (await this.replies()).length;
    const message =
      "text" in content
        ? { type: "text", text: { body: content.text } }
        : "tap" in content
          ? {
              type: "interactive",
              interactive: {
                type: "button_reply",
                button_reply: { id: content.tap, title: "option" },
              },
            }
          : {
              type: "button",
              button: { payload: content.button, text: "option" },
            };
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA-E2E",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "27110000000",
                  phone_number_id: WHATSAPP.phoneNumberId,
                },
                contacts: [
                  { profile: { name: "Patient" }, wa_id: this.number.slice(1) },
                ],
                messages: [
                  {
                    from: this.number.slice(1),
                    id: `wamid.e2e.${randomUUID().replace(/-/g, "")}`,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    ...message,
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const res = await fetch(`${API_URL}/v1/channels/whatsapp/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${createHmac("sha256", WHATSAPP.appSecret).update(raw).digest("hex")}`,
      },
      body: raw,
    });
    expect(res.status).toBe(200);
    return this.settled(before);
  }
}
