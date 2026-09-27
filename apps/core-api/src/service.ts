import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  ENABLED_CHANNELS,
  extractedReferralV2Schema,
  type AnyExtraction,
  type AppointmentAction,
  type AppointmentChange,
  type CaseAction,
  type Channel,
  type DocumentType,
  type FieldsPatch,
  type IngestRequest,
  type InteractionRequest,
  type ObservationImport,
  type ResolutionCode,
  type Subject,
  type WorkItemKind,
} from "@access/contracts";
import {
  AppError,
  activeBookingForReferral,
  applyPendingObservations,
  assertVersion,
  caseExecutions,
  caseSubject,
  conflict,
  createCase,
  enqueueDestination,
  evidence,
  executeCommand,
  executionInFlight,
  executionUnresolved,
  findCommand,
  loadApplicableRuleSet,
  loadRuleSet,
  lockCase,
  notFound,
  openWorkItem,
  recordEffort,
  recordInteraction,
  recordMilestone,
  recordObservation,
  referralAccessStatus,
  replay,
  requestHash,
  resolveWorkItems,
  tenantTx,
  transitionCase,
  updateOpenWorkItemReason,
  type ActorRef,
  type CaseRow,
  type CommandEnvelope,
  type DbClient,
  type Replayed,
} from "@access/db";
import { isTerminal, terminalOutcome } from "@access/domain";
import { log } from "@access/observability";
import {
  assertCaseTypeEnabled,
  authorize,
  evaluateAction,
} from "@access/policy";
import {
  evaluateReferralRules,
  ownerFor,
  unmetBookingPrerequisites,
  type ReferralFacts,
  type RuleSetRef,
} from "@access/rules";
import { AppointmentOperations } from "./appointments.js";
import type { AuthContext } from "./auth.js";
import type { ExtractionPort, ExtractionOutcome } from "./extraction.js";
import type { ArtifactScanner, ScanResult } from "./scanner.js";
import type { ArtifactStore, StoredObject } from "./storage.js";

export function decodeArtifact(content: string): Buffer {
  if (
    content.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(content) ||
    (content.includes("=") && content.indexOf("=") < content.length - 2)
  )
    throw new AppError(400, "ARTIFACT_MALFORMED", "malformed base64");
  const bytes = Buffer.from(content, "base64");
  if (bytes.toString("base64") !== content)
    throw new AppError(400, "ARTIFACT_MALFORMED", "malformed base64");
  if (bytes.length === 0 || bytes.length > 10_000_000)
    throw new AppError(400, "ARTIFACT_SIZE", "artifact size invalid");
  return bytes;
}
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

export interface ServiceDeps {
  pool: Pool;
  artifacts: ArtifactStore;
  scanner: ArtifactScanner;
  extractor: ExtractionPort;
  retentionDays: number;
}
interface ReferralRow {
  id: string;
  case_id: string;
  extraction: AnyExtraction | null;
  supplied_documents: DocumentType[];
  supplied_fields: FieldsPatch;
  identity_confirmed_by: string | null;
  rule_set_id: string | null;
  destination_reference: string | null;
  destination_mode: "CONNECTOR" | "MANUAL" | null;
}
type Ctx = { tenantId: string; correlationId: string; actor: ActorRef };

function requestContext(auth: AuthContext) {
  return {
    userId: auth.mode === "jwt" ? auth.userId : undefined,
    actorRole: auth.role,
  };
}
function assertChannel(channel: Channel) {
  if (!ENABLED_CHANNELS.includes(channel))
    throw new AppError(
      422,
      "CHANNEL_DISABLED",
      `channel ${channel} is not enabled`,
    );
}
const SAFETY_HOLDS: WorkItemKind[] = ["SAFETY", "FILE_SAFETY"];
/**
 * Appointment operations cases change only through their own commands
 * (appointment-actions); referral actions, interactions and imports never
 * touch them.
 */
function referralOnly(caseType: string, what: string) {
  if (caseType !== "REFERRAL")
    throw new AppError(
      422,
      "REFERRAL_CASES_ONLY",
      `${what} apply to referrals; use appointment actions for ${caseType}`,
    );
}

export class CaseService {
  private appointments = new AppointmentOperations();
  constructor(private deps: ServiceDeps) {}

  private tx<T>(auth: AuthContext, fn: (c: DbClient) => Promise<T>) {
    return tenantTx(auth.tenantId, fn, this.deps.pool, requestContext(auth));
  }

  // -------------------------------------------------------------------------
  // Intake
  // -------------------------------------------------------------------------

  async ingestReferral(auth: AuthContext, input: IngestRequest) {
    authorize(auth.role, "referral.ingest");
    if (input.tenant_id && input.tenant_id !== auth.tenantId)
      throw new AppError(
        403,
        "TENANT_MISMATCH",
        "tenant does not match the authenticated organisation",
      );
    assertChannel(input.channel);
    const bytes = decodeArtifact(input.content_base64);
    const envelope: CommandEnvelope = {
      tenantId: auth.tenantId,
      commandId: input.command_id,
      type: "referral.ingest",
      requestHash: requestHash({
        type: "referral.ingest",
        referral_id: input.referral_id,
        channel: input.channel,
        idempotency_key: input.idempotency_key ?? null,
        filename: input.filename,
        media_type: input.media_type,
        content_sha256: sha256(bytes),
        fixture: input.fixture ?? null,
        structured: input.structured ?? null,
      }),
      actor: auth.actor,
      subject: { type: "referral", id: input.referral_id },
    };
    // Replay before any side effect: no second scan, object or row.
    const early = await this.tx(auth, async (c) => {
      const prior = await findCommand(c, auth.tenantId, input.command_id);
      if (prior) return replay<Record<string, unknown>>(prior, envelope);
      if (!(await loadApplicableRuleSet(c, auth.tenantId)))
        throw conflict(
          "NO_ACTIVE_RULE_SET",
          "no active rule set for this organisation",
        );
      return null;
    });
    if (early) return early;
    const caseId = randomUUID();
    const ctx: Ctx = {
      tenantId: auth.tenantId,
      correlationId: input.correlation_id,
      actor: auth.actor,
    };
    const intake = await this.scanAndStore(
      auth.tenantId,
      caseId,
      bytes,
      input.media_type,
    );
    try {
      const extraction: ExtractionOutcome =
        intake.scan.status === "CLEAN"
          ? await this.deps.extractor.extract({
              bytes,
              scan: intake.scan,
              fixture: input.fixture,
              structured: input.structured,
            })
          : { kind: "none" };
      const result = await this.tx(auth, (c) =>
        executeCommand(c, envelope, async () => {
          const exists = await c.query(
            "SELECT 1 FROM referrals WHERE tenant_id=$1 AND id=$2",
            [auth.tenantId, input.referral_id],
          );
          if (exists.rowCount)
            throw conflict(
              "REFERRAL_EXISTS",
              "referral already exists (expected_version 0)",
            );
          const subject: Subject = { type: "referral", id: input.referral_id };
          let caseRow = await createCase(c, {
            ...ctx,
            caseId,
            caseType: "REFERRAL",
            channel: input.channel,
            subject,
          });
          const extracted =
            extraction.kind === "extracted" ? extraction.extraction : null;
          await c.query(
            `INSERT INTO referrals(id,tenant_id,case_id,extraction,referring_provider,requested_service,referral_date,supplied_documents)
             VALUES($1,$2,$3,$4,$5,$6,$7,'{}')`,
            [
              input.referral_id,
              auth.tenantId,
              caseId,
              extracted,
              extracted?.referrer.name ?? null,
              extracted?.schema_version === "referral-extraction.v2"
                ? (extracted.requested_service ?? null)
                : null,
              extracted?.schema_version === "referral-extraction.v2"
                ? (extracted.referral_date ?? null)
                : null,
            ],
          );
          const interactionId = randomUUID();
          const artifactId = await this.insertArtifact(c, ctx, caseRow, {
            referralId: input.referral_id,
            interactionId,
            intake,
            mediaType: input.media_type,
            documentTypes: extracted ? extracted.documents : [],
          });
          await recordInteraction(c, ctx, caseRow, {
            id: interactionId,
            channel: input.channel,
            direction: "INBOUND",
            actorType: auth.actor.type,
            actorId: auth.actor.id,
            intent: "NEW_REFERRAL",
            contentReference: artifactId,
            identityVerificationLevel: "NONE",
            idempotencyKey:
              input.idempotency_key ?? `command:${input.command_id}`,
            commandId: input.command_id,
          });
          await recordMilestone(c, ctx, caseRow, "REFERRAL_RECEIVED", {
            occurredAt: caseRow.opened_at,
            sourceType: "SYSTEM",
            verificationLevel: "OBSERVED",
          });
          let executionId: string | null = null;
          if (intake.scan.status === "REJECTED") {
            caseRow = await this.hold(
              c,
              ctx,
              caseRow,
              input.referral_id,
              "FILE_SAFETY",
              "file_rejected_by_scanner",
              null,
            );
          } else if (extraction.kind === "safety_hold") {
            await evidence(c, ctx, caseRow, subject, {
              eventType: "safety_hold",
              payload: {
                reason: extraction.reason,
                scope: "administrative_only",
              },
            });
            caseRow = await this.hold(
              c,
              ctx,
              caseRow,
              input.referral_id,
              "SAFETY",
              extraction.reason,
              null,
            );
          } else {
            const ruleSet = await loadApplicableRuleSet(c, auth.tenantId);
            if (!ruleSet)
              throw conflict(
                "NO_ACTIVE_RULE_SET",
                "no active rule set for this organisation",
              );
            const applied = await this.applyRules(
              c,
              ctx,
              caseRow,
              input.referral_id,
              ruleSet,
              {
                extraction: extracted,
                supplied_documents: [],
                supplied_fields: {},
                identity_confirmed_by_staff: false,
              },
            );
            caseRow = applied.caseRow;
            executionId = applied.executionId;
          }
          return {
            case_id: caseRow.id,
            referral_id: input.referral_id,
            interaction_id: interactionId,
            state: caseRow.current_state,
            version: caseRow.version,
            execution_id: executionId,
          };
        }),
      );
      if (result.deduplicated) await this.discard(auth, intake.stored);
      return result;
    } catch (error) {
      await this.discard(auth, intake.stored);
      throw error;
    }
  }

  /** Scan in memory, then store ciphertext only when CLEAN. */
  private async scanAndStore(
    tenantId: string,
    caseId: string,
    bytes: Buffer,
    contentType: string,
  ): Promise<{
    scan: ScanResult;
    stored: StoredObject | null;
    digest: string;
    size: number;
  }> {
    const scan = await this.deps.scanner.scan(bytes);
    if (scan.status === "ERROR")
      throw new AppError(
        503,
        "SCANNER_UNAVAILABLE",
        "file scanning unavailable; upload refused",
      );
    const stored =
      scan.status === "CLEAN"
        ? await this.deps.artifacts.put({
            tenantId,
            caseId,
            bytes,
            contentType,
          })
        : null;
    return { scan, stored, digest: sha256(bytes), size: bytes.length };
  }

  /**
   * Remove an object that no committed row references. Object keys are
   * random per attempt, so an object is only ever referenced by the request
   * that wrote it and deleting an unreferenced one cannot race a commit.
   */
  private async discard(auth: AuthContext, stored: StoredObject | null) {
    if (!stored) return;
    try {
      const referenced = await this.tx(auth, (c) =>
        c.query(
          "SELECT 1 FROM artifacts WHERE tenant_id=$1 AND object_key=$2",
          [auth.tenantId, stored.objectKey],
        ),
      );
      if (!referenced.rowCount)
        await this.deps.artifacts.remove(stored.objectKey);
    } catch {
      log("error", "artifact_cleanup_failed", {
        tenant_id: auth.tenantId,
        object_key: stored.objectKey,
      });
    }
  }

  private async insertArtifact(
    c: DbClient,
    ctx: Ctx,
    caseRow: CaseRow,
    input: {
      referralId: string | null;
      interactionId: string;
      intake: {
        scan: ScanResult;
        stored: StoredObject | null;
        digest: string;
        size: number;
      };
      mediaType: string;
      documentTypes: readonly string[];
    },
  ): Promise<string> {
    const artifactId = randomUUID();
    const inserted = await c.query(
      `INSERT INTO artifacts(id,tenant_id,case_id,referral_id,interaction_id,object_key,digest_sha256,media_type,size_bytes,scan_status,scanner,scanned_at,encryption_key_id,storage_backend,object_version,document_types,retention_until)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),$12,$13,$14,$15,now()+($16||' days')::interval)
       ON CONFLICT (tenant_id,case_id,digest_sha256) DO NOTHING`,
      [
        artifactId,
        ctx.tenantId,
        caseRow.id,
        input.referralId,
        input.interactionId,
        input.intake.stored?.objectKey ?? null,
        input.intake.digest,
        input.mediaType,
        input.intake.size,
        input.intake.scan.status,
        input.intake.scan.scanner,
        input.intake.stored?.keyId ?? "none",
        input.intake.stored?.backend ?? "none",
        input.intake.stored?.objectVersion ?? null,
        input.documentTypes,
        this.deps.retentionDays,
      ],
    );
    if (!inserted.rowCount)
      throw conflict(
        "ARTIFACT_DUPLICATE",
        "this document is already attached to the case",
      );
    await evidence(c, ctx, caseRow, caseSubject(caseRow), {
      eventType: "artifact_recorded",
      payload: {
        artifact_id: artifactId,
        digest_sha256: input.intake.digest,
        size_bytes: input.intake.size,
        scan_status: input.intake.scan.status,
        scanner: input.intake.scan.scanner,
        signature: input.intake.scan.signature ?? null,
        storage_backend: input.intake.stored?.backend ?? "none",
        document_types: input.documentTypes,
      },
    });
    return artifactId;
  }

  private async hold(
    c: DbClient,
    ctx: Ctx,
    caseRow: CaseRow,
    referralId: string | null,
    kind: "SAFETY" | "FILE_SAFETY",
    reason: string,
    ruleSet: RuleSetRef | null,
  ): Promise<CaseRow> {
    const row = await transitionCase(c, ctx, caseRow, {
      to: "EXCEPTION",
      reason,
      owner: ownerFor(
        ruleSet?.definition ?? null,
        kind === "SAFETY" ? "SAFETY" : "FILE_SAFETY",
      ),
      exceptionReason: reason,
    });
    await openWorkItem(c, ctx, row, {
      kind,
      reason,
      ownerRole:
        kind === "SAFETY" ? "PRACTICE_MANAGER" : "REFERRAL_COORDINATOR",
      referralId,
      evidence: { scope: "administrative_only" },
    });
    return row;
  }

  /**
   * Evaluate the pinned (or currently applicable) rule set and move the case
   * accordingly. Administrative only: readiness, routing and ownership.
   */
  private async applyRules(
    c: DbClient,
    ctx: Ctx,
    caseRowIn: CaseRow,
    referralId: string,
    ruleSet: RuleSetRef,
    facts: ReferralFacts,
  ): Promise<{ caseRow: CaseRow; executionId: string | null }> {
    let caseRow = caseRowIn;
    const decision = evaluateReferralRules(ruleSet, facts);
    const d = ruleSet.definition;
    const incomplete =
      decision.missing_fields.length +
        decision.missing_documents.length +
        decision.unmet_prerequisites.length >
      0;
    await c.query(
      `UPDATE referrals SET rule_set_id=$3,rule_set_version=$4,rule_decision=$5,identity_status=$6,completeness_status=$7,destination_mode=$8,updated_at=now()
        WHERE tenant_id=$1 AND id=$2`,
      [
        ctx.tenantId,
        referralId,
        ruleSet.id,
        ruleSet.version,
        decision,
        decision.identity.status,
        incomplete ? "INCOMPLETE" : "COMPLETE",
        decision.destination_mode,
      ],
    );
    const subject: Subject = { type: "referral", id: referralId };
    await evidence(c, ctx, caseRow, subject, {
      eventType: "rule_decision_recorded",
      payload: {
        rule_set_id: ruleSet.id,
        rule_set_version: ruleSet.version,
        definition_hash: ruleSet.definition_hash,
        input_hash: decision.input_hash,
        decision_hash: decision.decision_hash,
        outcome: decision.outcome,
        identity: decision.identity,
        missing_fields: decision.missing_fields,
        missing_documents: decision.missing_documents,
        unmet_prerequisites: decision.unmet_prerequisites,
        routing: decision.routing,
        destination_mode: decision.destination_mode,
      },
    });
    if (decision.identity.status === "RESOLVED")
      await recordMilestone(
        c,
        ctx,
        caseRow,
        "REFERRAL_VERIFIED",
        facts.identity_confirmed_by_staff
          ? {
              sourceType: "STAFF",
              verificationLevel: "HUMAN_ATTESTED",
              actorId: ctx.actor.id,
            }
          : { sourceType: "SYSTEM", verificationLevel: "DERIVED" },
      );
    let executionId: string | null = null;
    const missing = [
      ...decision.missing_fields,
      ...decision.missing_documents,
      ...decision.unmet_prerequisites,
    ];
    if (decision.outcome === "IDENTITY_PENDING") {
      if (caseRow.current_state !== "IDENTITY_PENDING")
        caseRow = await transitionCase(c, ctx, caseRow, {
          to: "IDENTITY_PENDING",
          reason: `rule_decision:${decision.identity.reason}`,
          owner: ownerFor(d, "IDENTITY"),
        });
      await openWorkItem(c, ctx, caseRow, {
        kind: "IDENTITY",
        reason: `identity_${decision.identity.reason}`,
        ownerRole: ownerFor(d, "IDENTITY"),
        referralId,
        evidence: { rule_set_version: ruleSet.version },
      });
    } else if (decision.outcome === "INFORMATION_MISSING") {
      await resolveWorkItems(c, ctx, caseRow, {
        kinds: ["IDENTITY"],
        resolution: "identity_resolved",
        note: null,
        staffSeconds: undefined,
        automatic: true,
      });
      if (caseRow.current_state !== "INFORMATION_MISSING")
        caseRow = await transitionCase(c, ctx, caseRow, {
          to: "INFORMATION_MISSING",
          reason: "rule_decision:information_missing",
          owner: ownerFor(d, "COMPLETENESS"),
        });
      const opened = await openWorkItem(c, ctx, caseRow, {
        kind: "COMPLETENESS",
        reason: `missing:${missing.join(",")}`,
        ownerRole: ownerFor(d, "COMPLETENESS"),
        referralId,
        evidence: { missing },
      });
      if (!opened.created)
        await updateOpenWorkItemReason(
          c,
          ctx.tenantId,
          caseRow.id,
          "COMPLETENESS",
          `missing:${missing.join(",")}`,
          { missing },
        );
    } else {
      await recordMilestone(c, ctx, caseRow, "REFERRAL_READY", {
        sourceType: "SYSTEM",
        verificationLevel: "DERIVED",
        payload: {
          rule_set_version: ruleSet.version,
          decision_hash: decision.decision_hash,
        },
      });
      await resolveWorkItems(c, ctx, caseRow, {
        kinds: ["IDENTITY", "COMPLETENESS"],
        resolution: "requirements_met",
        note: null,
        staffSeconds: undefined,
        automatic: true,
      });
      const policy = evaluateAction({
        caseType: caseRow.case_type,
        action: "referral.create",
        ready: true,
      });
      await c.query(
        "UPDATE referrals SET policy_decision=$3 WHERE tenant_id=$1 AND id=$2",
        [ctx.tenantId, referralId, policy],
      );
      if (
        decision.destination_mode === "CONNECTOR" &&
        policy.effect === "ALLOW"
      ) {
        caseRow = await transitionCase(c, ctx, caseRow, {
          to: "DESTINATION_PENDING",
          reason: "rule_decision:ready",
          owner: "SYSTEM",
        });
        executionId = await enqueueDestination(c, ctx, caseRow, {
          operation: "referral.create",
          subject,
          payload: { referral_id: referralId, routing: decision.routing },
        });
      } else {
        if (caseRow.current_state !== "READY")
          caseRow = await transitionCase(c, ctx, caseRow, {
            to: "READY",
            reason: "rule_decision:ready_manual_destination",
            owner: ownerFor(d, "MANUAL_DESTINATION"),
          });
        await openWorkItem(c, ctx, caseRow, {
          kind: "MANUAL_DESTINATION",
          reason: "enter_referral_in_destination_system",
          ownerRole: ownerFor(d, "MANUAL_DESTINATION"),
          referralId,
          evidence: { routing: decision.routing },
        });
      }
    }
    return { caseRow, executionId };
  }

  private async referral(
    c: DbClient,
    tenantId: string,
    caseId: string,
  ): Promise<ReferralRow> {
    const row = await c.query<ReferralRow>(
      `SELECT id,case_id,extraction,supplied_documents,supplied_fields,identity_confirmed_by,rule_set_id,destination_reference,destination_mode
         FROM referrals WHERE tenant_id=$1 AND case_id=$2 FOR UPDATE`,
      [tenantId, caseId],
    );
    if (!row.rows[0]) throw notFound("referral");
    return row.rows[0];
  }
  private facts(
    r: ReferralRow,
    overrides: Partial<ReferralFacts> = {},
  ): ReferralFacts {
    return {
      extraction: r.extraction,
      supplied_documents: r.supplied_documents,
      supplied_fields: r.supplied_fields,
      identity_confirmed_by_staff: Boolean(r.identity_confirmed_by),
      ...overrides,
    };
  }
  private async pinnedRuleSet(
    c: DbClient,
    tenantId: string,
    r: ReferralRow,
  ): Promise<RuleSetRef> {
    if (r.rule_set_id) return loadRuleSet(c, tenantId, r.rule_set_id);
    const current = await loadApplicableRuleSet(c, tenantId);
    if (!current)
      throw conflict(
        "NO_ACTIVE_RULE_SET",
        "no active rule set for this organisation",
      );
    return current;
  }
  private async openKinds(
    c: DbClient,
    tenantId: string,
    caseId: string,
  ): Promise<WorkItemKind[]> {
    const rows = await c.query<{ kind: WorkItemKind }>(
      "SELECT kind FROM work_items WHERE tenant_id=$1 AND case_id=$2 AND status='OPEN'",
      [tenantId, caseId],
    );
    return rows.rows.map((r) => r.kind);
  }
  /** Re-evaluation is allowed before the destination and outside holds. */
  private async canReevaluate(
    c: DbClient,
    tenantId: string,
    caseRow: CaseRow,
  ): Promise<boolean> {
    if (
      ["IDENTITY_PENDING", "INFORMATION_MISSING"].includes(
        caseRow.current_state,
      )
    )
      return true;
    if (caseRow.current_state !== "EXCEPTION") return false;
    const kinds = await this.openKinds(c, tenantId, caseRow.id);
    if (
      kinds.some((k) =>
        [...SAFETY_HOLDS, "CONNECTOR", "MANUAL_DESTINATION"].includes(k),
      )
    )
      return false;
    return !(await caseExecutions(c, tenantId, caseRow.id)).some(
      executionUnresolved,
    );
  }

  // -------------------------------------------------------------------------
  // Interactions on an existing case
  // -------------------------------------------------------------------------

  async addInteraction(
    auth: AuthContext,
    caseId: string,
    input: InteractionRequest,
  ) {
    authorize(auth.role, "case.interaction");
    assertChannel(input.channel);
    const bytes = input.artifact
      ? decodeArtifact(input.artifact.content_base64)
      : null;
    const envelope: CommandEnvelope = {
      tenantId: auth.tenantId,
      commandId: input.command_id,
      type: "case.interaction",
      requestHash: requestHash({
        type: "case.interaction",
        case_id: caseId,
        ...input,
        command_id: undefined,
        correlation_id: undefined,
        artifact: input.artifact
          ? {
              ...input.artifact,
              content_base64: undefined,
              content_sha256: sha256(bytes!),
            }
          : null,
      }),
      actor: auth.actor,
      caseId,
      subject: { type: "case", id: caseId },
    };
    const early = await this.tx(auth, async (c) => {
      const prior = await findCommand(c, auth.tenantId, input.command_id);
      if (prior) return replay<Record<string, unknown>>(prior, envelope);
      const kase = await c.query<{ case_type: string }>(
        "SELECT case_type FROM access_cases WHERE tenant_id=$1 AND id=$2",
        [auth.tenantId, caseId],
      );
      if (!kase.rows[0]) throw notFound();
      assertCaseTypeEnabled(kase.rows[0].case_type);
      referralOnly(kase.rows[0].case_type, "interactions");
      return null;
    });
    if (early) return early;
    const intake =
      bytes && input.artifact
        ? await this.scanAndStore(
            auth.tenantId,
            caseId,
            bytes,
            input.artifact.media_type,
          )
        : null;
    const ctx: Ctx = {
      tenantId: auth.tenantId,
      correlationId: input.correlation_id,
      actor: auth.actor,
    };
    try {
      const result = await this.tx(auth, (c) =>
        executeCommand(c, envelope, async () => {
          let caseRow = await lockCase(c, auth.tenantId, caseId);
          assertCaseTypeEnabled(caseRow.case_type);
          referralOnly(caseRow.case_type, "interactions");
          assertVersion(caseRow, input.expected_version);
          if (
            isTerminal(caseRow.current_state) &&
            input.intent === "MISSING_INFORMATION"
          )
            throw conflict("CASE_RESOLVED", "case is already resolved");
          const r = await this.referral(c, auth.tenantId, caseId);
          const interactionId = randomUUID();
          const artifactId =
            intake && input.artifact
              ? await this.insertArtifact(c, ctx, caseRow, {
                  referralId: r.id,
                  interactionId,
                  intake,
                  mediaType: input.artifact.media_type,
                  documentTypes:
                    intake.scan.status === "CLEAN"
                      ? input.artifact.document_types
                      : [],
                })
              : null;
          await recordInteraction(c, ctx, caseRow, {
            id: interactionId,
            channel: input.channel,
            direction: "INBOUND",
            actorType: input.actor_type,
            actorId: auth.actor.id,
            intent: input.intent,
            contentReference: artifactId,
            identityVerificationLevel:
              input.actor_type === "STAFF" ? "STAFF_VERIFIED" : "CLAIMED",
            idempotencyKey:
              input.idempotency_key ?? `command:${input.command_id}`,
            commandId: input.command_id,
          });
          if (input.intent === "STATUS_ENQUIRY")
            await recordEffort(c, ctx, caseId, {
              type: "STATUS_CONTACT",
              source: "STAFF",
              seconds: input.staff_seconds,
              commandId: input.command_id,
            });
          let executionId: string | null = null;
          if (input.intent === "MISSING_INFORMATION") {
            if (intake?.scan.status === "REJECTED")
              await openWorkItem(c, ctx, caseRow, {
                kind: "FILE_SAFETY",
                reason: "supplementary_file_rejected_by_scanner",
                ownerRole: "REFERRAL_COORDINATOR",
                referralId: r.id,
              });
            else {
              const documents = [
                ...new Set([
                  ...r.supplied_documents,
                  ...(input.artifact?.document_types ?? []),
                ]),
              ];
              const fields = { ...r.supplied_fields, ...(input.fields ?? {}) };
              await c.query(
                "UPDATE referrals SET supplied_documents=$3,supplied_fields=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2",
                [auth.tenantId, r.id, documents, fields],
              );
              await recordEffort(c, ctx, caseId, {
                type: "MANUAL_CORRECTION",
                source: "STAFF",
                seconds: input.staff_seconds,
                commandId: input.command_id,
              });
              if (await this.canReevaluate(c, auth.tenantId, caseRow)) {
                const ruleSet = await this.pinnedRuleSet(c, auth.tenantId, r);
                const applied = await this.applyRules(
                  c,
                  ctx,
                  caseRow,
                  r.id,
                  ruleSet,
                  this.facts(r, {
                    supplied_documents: documents,
                    supplied_fields: fields,
                  }),
                );
                caseRow = applied.caseRow;
                executionId = applied.executionId;
              }
            }
          }
          return {
            case_id: caseId,
            interaction_id: interactionId,
            state: caseRow.current_state,
            version: caseRow.version,
            execution_id: executionId,
            // Answered from authoritative state only; nothing is generated.
            access_status:
              input.intent === "STATUS_ENQUIRY"
                ? await referralAccessStatus(c, auth.tenantId, caseRow)
                : null,
          };
        }),
      );
      if (result.deduplicated) await this.discard(auth, intake?.stored ?? null);
      return result;
    } catch (error) {
      await this.discard(auth, intake?.stored ?? null);
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Staff actions
  // -------------------------------------------------------------------------

  async performAction(auth: AuthContext, caseId: string, action: CaseAction) {
    authorize(auth.role, `case.action.${action.action}`);
    const envelope: CommandEnvelope = {
      tenantId: auth.tenantId,
      commandId: action.command_id,
      type: "case.action",
      requestHash: requestHash({
        type: "case.action",
        case_id: caseId,
        ...action,
        command_id: undefined,
        correlation_id: undefined,
      }),
      actor: auth.actor,
      caseId,
      subject: { type: "case", id: caseId },
    };
    const ctx: Ctx = {
      tenantId: auth.tenantId,
      correlationId: action.correlation_id,
      actor: auth.actor,
    };
    return this.tx(auth, (c) =>
      executeCommand(c, envelope, async () => {
        const caseRow = await lockCase(c, auth.tenantId, caseId);
        // Disabled case types fail closed before anything else is considered.
        assertCaseTypeEnabled(caseRow.case_type);
        referralOnly(caseRow.case_type, "case actions");
        assertVersion(caseRow, action.expected_version);
        const r = await this.referral(c, auth.tenantId, caseId);
        const out = await this.dispatchAction(c, ctx, caseRow, r, action);
        await evidence(c, ctx, out.caseRow, caseSubject(out.caseRow), {
          eventType: "staff_action_recorded",
          payload: {
            action: action.action,
            note: action.note,
            staff_seconds: action.staff_seconds ?? null,
            command_id: action.command_id,
          },
        });
        return {
          case_id: caseId,
          action: action.action,
          state: out.caseRow.current_state,
          version: out.caseRow.version,
          execution_id: out.executionId ?? null,
          observation_id: out.observationId ?? null,
          appointment_case_id: out.appointmentCaseId ?? null,
        };
      }),
    );
  }

  private notApplicable(action: string, state: string): AppError {
    return conflict(
      "ACTION_NOT_APPLICABLE",
      `${action} is not applicable in state ${state}`,
    );
  }

  private async dispatchAction(
    c: DbClient,
    ctx: Ctx,
    caseRow: CaseRow,
    r: ReferralRow,
    action: CaseAction,
  ): Promise<{
    caseRow: CaseRow;
    executionId?: string | null;
    observationId?: string;
    appointmentCaseId?: string;
  }> {
    const staffSeconds = action.staff_seconds;
    const cmd = action.command_id;
    switch (action.action) {
      case "confirm_identity": {
        if (
          !(await this.canReevaluate(c, ctx.tenantId, caseRow)) ||
          !(await this.openKinds(c, ctx.tenantId, caseRow.id)).includes(
            "IDENTITY",
          )
        )
          throw this.notApplicable(action.action, caseRow.current_state);
        await c.query(
          "UPDATE referrals SET identity_confirmed_by=$3 WHERE tenant_id=$1 AND id=$2",
          [ctx.tenantId, r.id, ctx.actor.id],
        );
        await resolveWorkItems(c, ctx, caseRow, {
          kinds: ["IDENTITY"],
          resolution: "identity_confirmed_by_staff",
          note: action.note,
          staffSeconds,
        });
        await evidence(
          c,
          ctx,
          caseRow,
          { type: "referral", id: r.id },
          {
            eventType: "identity_confirmed",
            payload: {
              confirmed_by: ctx.actor.id,
              verification: "HUMAN_ATTESTED",
            },
          },
        );
        const ruleSet = await this.pinnedRuleSet(c, ctx.tenantId, r);
        return this.applyRules(
          c,
          ctx,
          caseRow,
          r.id,
          ruleSet,
          this.facts(r, { identity_confirmed_by_staff: true }),
        );
      }
      case "provide_information": {
        if (
          (await this.openKinds(c, ctx.tenantId, caseRow.id)).some((k) =>
            SAFETY_HOLDS.includes(k),
          )
        )
          throw conflict(
            "SAFETY_REVIEW_REQUIRED",
            "resolve the safety review before continuing administrative processing",
          );
        if (!(await this.canReevaluate(c, ctx.tenantId, caseRow)))
          throw this.notApplicable(action.action, caseRow.current_state);
        const extraction = action.structured
          ? extractedReferralV2Schema.parse({
              schema_version: "referral-extraction.v2",
              patient: action.structured.patient,
              referrer: action.structured.referrer,
              ...(action.structured.reason
                ? { reason: action.structured.reason }
                : {}),
              ...(action.structured.requested_service
                ? { requested_service: action.structured.requested_service }
                : {}),
              ...(action.structured.referral_date
                ? { referral_date: action.structured.referral_date }
                : {}),
              ...(action.structured.funding
                ? { funding: action.structured.funding }
                : {}),
              documents: [...new Set(action.structured.documents)],
              confidence: 1,
              provenance: "STAFF_ENTERED",
            })
          : r.extraction;
        const documents = [
          ...new Set([...r.supplied_documents, ...action.documents]),
        ];
        const fields = { ...r.supplied_fields, ...(action.fields ?? {}) };
        await c.query(
          "UPDATE referrals SET extraction=$3,supplied_documents=$4,supplied_fields=$5,referring_provider=coalesce($6,referring_provider),updated_at=now() WHERE tenant_id=$1 AND id=$2",
          [
            ctx.tenantId,
            r.id,
            extraction,
            documents,
            fields,
            extraction?.referrer.name ?? null,
          ],
        );
        await recordInteraction(c, ctx, caseRow, {
          channel: "STAFF_UPLOAD",
          direction: "INBOUND",
          actorType: "STAFF",
          actorId: ctx.actor.id,
          intent: "MISSING_INFORMATION",
          contentReference: null,
          identityVerificationLevel: "STAFF_VERIFIED",
          idempotencyKey: `command:${cmd}`,
          commandId: cmd,
        });
        await recordEffort(c, ctx, caseRow.id, {
          type: "MANUAL_CORRECTION",
          source: "STAFF",
          seconds: staffSeconds,
          commandId: cmd,
        });
        const ruleSet = await this.pinnedRuleSet(c, ctx.tenantId, r);
        return this.applyRules(
          c,
          ctx,
          caseRow,
          r.id,
          ruleSet,
          this.facts(
            { ...r, extraction },
            {
              supplied_documents: documents,
              supplied_fields: fields,
            },
          ),
        );
      }
      case "resolve_exception":
        return this.resolveException(c, ctx, caseRow, r, action);
      case "record_destination_reference": {
        const kinds = await this.openKinds(c, ctx.tenantId, caseRow.id);
        const eligible =
          (caseRow.current_state === "READY" &&
            r.destination_mode !== "CONNECTOR") ||
          (caseRow.current_state === "EXCEPTION" &&
            kinds.some((k) => k === "CONNECTOR" || k === "MANUAL_DESTINATION"));
        if (!eligible)
          throw this.notApplicable(action.action, caseRow.current_state);
        if (kinds.some((k) => SAFETY_HOLDS.includes(k)))
          throw conflict(
            "SAFETY_REVIEW_REQUIRED",
            "resolve the safety review first",
          );
        const executions = await caseExecutions(c, ctx.tenantId, caseRow.id);
        if (executions.some(executionInFlight))
          throw conflict(
            "EXECUTION_IN_FLIGHT",
            "an automated destination action is still in progress",
          );
        // Staff located the referral in the destination: this settles any
        // escalated ambiguous write for the same intended effect.
        for (const e of executions.filter(executionUnresolved))
          await c.query(
            "UPDATE executions SET superseded_at=now(),superseded_by=$3,superseded_reason='manual_destination_reference' WHERE tenant_id=$1 AND id=$2",
            [ctx.tenantId, e.id, ctx.actor.id],
          );
        await c.query(
          "UPDATE referrals SET destination_reference=$3,destination_reference_source='MANUAL',destination_committed_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2",
          [ctx.tenantId, r.id, action.destination_reference],
        );
        await recordEffort(c, ctx, caseRow.id, {
          type: "MANUAL_DESTINATION_ACTION",
          source: "STAFF",
          seconds: staffSeconds,
          commandId: cmd,
        });
        await resolveWorkItems(c, ctx, caseRow, {
          kinds: ["MANUAL_DESTINATION", "CONNECTOR"],
          resolution: "destination_reference_recorded",
          note: action.note,
          staffSeconds: undefined,
          // The MANUAL_DESTINATION_ACTION effort above is the human touch.
          automatic: true,
        });
        return this.enterReadyForBooking(c, ctx, caseRow, r, {
          source: "STAFF",
          reference: action.destination_reference,
        });
      }
      case "record_follow_up": {
        if (!["READY_FOR_BOOKING", "WAITING"].includes(caseRow.current_state))
          throw this.notApplicable(action.action, caseRow.current_state);
        await this.assertNoActiveBooking(c, ctx.tenantId, caseRow.id);
        const ruleSet = await this.pinnedRuleSet(c, ctx.tenantId, r);
        const due = action.follow_up_due_at
          ? new Date(action.follow_up_due_at)
          : new Date(
              Date.now() +
                ruleSet.definition.follow_up.waiting_hours * 3600_000,
            );
        await c.query(
          "UPDATE referrals SET follow_up_count=follow_up_count+1,follow_up_due_at=$3 WHERE tenant_id=$1 AND id=$2",
          [ctx.tenantId, r.id, due],
        );
        await recordEffort(c, ctx, caseRow.id, {
          type: "FOLLOW_UP",
          source: "STAFF",
          seconds: staffSeconds,
          commandId: cmd,
        });
        await resolveWorkItems(c, ctx, caseRow, {
          kinds: ["FOLLOW_UP"],
          resolution: "follow_up_recorded",
          note: action.note,
          staffSeconds: undefined,
          automatic: true,
        });
        await evidence(c, ctx, caseRow, caseSubject(caseRow), {
          eventType: "follow_up_recorded",
          payload: { follow_up_due_at: due.toISOString() },
        });
        return {
          caseRow:
            caseRow.current_state === "READY_FOR_BOOKING"
              ? await transitionCase(c, ctx, caseRow, {
                  to: "WAITING",
                  reason: "follow_up_recorded",
                  owner: "REFERRAL_COORDINATOR",
                })
              : caseRow,
        };
      }
      case "record_booking": {
        if (!["READY_FOR_BOOKING", "WAITING"].includes(caseRow.current_state))
          throw this.notApplicable(action.action, caseRow.current_state);
        const occurredAt = this.outcomeTime(caseRow, action.occurred_at);
        const ruleSet = await this.pinnedRuleSet(c, ctx.tenantId, r);
        const unmet = unmetBookingPrerequisites(
          ruleSet.definition,
          this.facts(r),
          r.destination_reference,
        );
        if (unmet.length)
          throw new AppError(
            422,
            "BOOKING_PREREQUISITES_UNMET",
            `booking prerequisites unmet: ${unmet.join(", ")}`,
          );
        return this.staffOutcome(
          c,
          ctx,
          caseRow,
          "APPOINTMENT_BOOKED",
          occurredAt,
          cmd,
          staffSeconds,
          {
            appointment_reference: action.appointment_reference ?? null,
          },
        );
      }
      case "record_patient_unreachable":
        return this.staffOutcome(
          c,
          ctx,
          caseRow,
          "PATIENT_UNREACHABLE",
          this.outcomeTime(caseRow, action.occurred_at),
          cmd,
          staffSeconds,
        );
      case "record_patient_declined":
        return this.staffOutcome(
          c,
          ctx,
          caseRow,
          "PATIENT_DECLINED",
          this.outcomeTime(caseRow, action.occurred_at),
          cmd,
          staffSeconds,
        );
      case "record_provider_declined":
        return this.staffOutcome(
          c,
          ctx,
          caseRow,
          "PROVIDER_DECLINED",
          this.outcomeTime(caseRow, action.occurred_at),
          cmd,
          staffSeconds,
        );
      case "close": {
        if (action.resolution_code === "BOOKED")
          throw new AppError(
            422,
            "USE_RECORD_BOOKING",
            "record a booking with record_booking",
          );
        return this.staffOutcome(
          c,
          ctx,
          caseRow,
          "REFERRAL_CLOSED",
          this.outcomeTime(caseRow, action.occurred_at),
          cmd,
          staffSeconds,
          {},
          action.resolution_code,
        );
      }
      case "reject": {
        if (
          !["IDENTITY_PENDING", "INFORMATION_MISSING", "EXCEPTION"].includes(
            caseRow.current_state,
          )
        )
          throw this.notApplicable(action.action, caseRow.current_state);
        if (
          (await caseExecutions(c, ctx.tenantId, caseRow.id)).some(
            executionInFlight,
          )
        )
          throw conflict(
            "EXECUTION_IN_FLIGHT",
            "an automated destination action is still in progress",
          );
        await recordEffort(c, ctx, caseRow.id, {
          type: "OUTCOME_RECORDED",
          source: "STAFF",
          seconds: staffSeconds,
          commandId: cmd,
        });
        return {
          caseRow: await transitionCase(c, ctx, caseRow, {
            to: "REJECTED",
            reason: "rejected_by_staff",
            resolution: {
              code: action.resolution_code,
              outcomeAt: new Date(),
              source: "STAFF",
              actorId: ctx.actor.id,
              reference: cmd,
            },
          }),
        };
      }
      case "correct_outcome": {
        if (!["BOOKED", "CLOSED"].includes(caseRow.current_state))
          throw this.notApplicable(action.action, caseRow.current_state);
        const obs = await c.query<{
          id: string;
          observation_type: string;
          occurred_at: Date;
          source_type: string;
          source_reference: string;
          actor_id: string | null;
          disposition: string;
          payload: { resolution_code?: string };
        }>(
          "SELECT id,observation_type,occurred_at,source_type,source_reference,actor_id,disposition,payload FROM access_case_observations WHERE tenant_id=$1 AND case_id=$2 AND id=$3",
          [ctx.tenantId, caseRow.id, action.observation_id],
        );
        const o = obs.rows[0];
        if (!o || o.disposition !== "REVIEW")
          throw conflict(
            "OBSERVATION_NOT_UNDER_REVIEW",
            "only an observation held for review can correct an outcome",
          );
        const target = terminalOutcome(
          o.observation_type as never,
          o.payload.resolution_code as never,
        );
        if (!target || target.code === caseRow.resolution_code)
          throw conflict(
            "CORRECTION_NOT_APPLICABLE",
            "the observation does not change the outcome",
          );
        const row = await transitionCase(c, ctx, caseRow, {
          to: target.state,
          reason: "outcome_corrected",
          resolution: {
            code: target.code,
            outcomeAt: new Date(o.occurred_at),
            source: o.source_type as never,
            actorId:
              o.actor_id ??
              `${o.source_type.toLowerCase()}:${o.source_reference}`,
            reference: o.id,
          },
          details: {
            previous_resolution: caseRow.resolution_code,
            corrected_by: ctx.actor.id,
            observation_id: o.id,
          },
        });
        await recordEffort(c, ctx, caseRow.id, {
          type: "MANUAL_CORRECTION",
          source: "STAFF",
          seconds: staffSeconds,
          commandId: cmd,
        });
        return { caseRow: row };
      }
      case "start_booking":
        return this.appointments.startBooking(c, ctx, caseRow, action);
    }
  }

  private outcomeTime(caseRow: CaseRow, iso: string | undefined): Date {
    const at = iso ? new Date(iso) : new Date();
    if (at.getTime() > Date.now() + 5 * 60_000)
      throw new AppError(
        422,
        "OUTCOME_IN_FUTURE",
        "outcome time cannot be in the future",
      );
    // Console inputs have minute precision; allow the same five-minute skew.
    if (at.getTime() < new Date(caseRow.opened_at).getTime() - 5 * 60_000)
      throw new AppError(
        422,
        "OUTCOME_BEFORE_RECEIPT",
        "outcome time precedes referral receipt",
      );
    return at;
  }

  /** A staff-recorded outcome goes through the same observation engine. */
  private async staffOutcome(
    c: DbClient,
    ctx: Ctx,
    caseRow: CaseRow,
    type:
      | "APPOINTMENT_BOOKED"
      | "PATIENT_UNREACHABLE"
      | "PATIENT_DECLINED"
      | "PROVIDER_DECLINED"
      | "REFERRAL_CLOSED",
    occurredAt: Date,
    commandId: string,
    staffSeconds: number | undefined,
    payload: object = {},
    resolutionCode?: ResolutionCode,
  ) {
    if (
      (await caseExecutions(c, ctx.tenantId, caseRow.id)).some(
        executionInFlight,
      )
    )
      throw conflict(
        "EXECUTION_IN_FLIGHT",
        "an automated destination action is still in progress",
      );
    await this.assertNoActiveBooking(c, ctx.tenantId, caseRow.id);
    const result = await recordObservation(c, ctx, caseRow, {
      type,
      occurredAt,
      sourceType: "STAFF",
      sourceReference: `command:${commandId}`,
      verificationLevel: "HUMAN_ATTESTED",
      actorId: ctx.actor.id,
      payload,
      authority: "STAFF",
      ...(resolutionCode ? { resolutionCode } : {}),
    });
    if (result.plan.disposition !== "APPLIED")
      throw conflict(
        "ACTION_NOT_APPLICABLE",
        `outcome cannot be applied in state ${caseRow.current_state}`,
      );
    await recordEffort(c, ctx, caseRow.id, {
      type: "OUTCOME_RECORDED",
      source: "STAFF",
      seconds: staffSeconds,
      commandId,
    });
    return { caseRow: result.caseRow, observationId: result.observationId };
  }

  /**
   * While ACCESS is booking a referral, its outcome and follow-up are the
   * booking's: staff cannot record a second booking (or close it) by hand.
   */
  private async assertNoActiveBooking(
    c: DbClient,
    tenantId: string,
    caseId: string,
  ) {
    if (await activeBookingForReferral(c, tenantId, caseId))
      throw conflict(
        "BOOKING_IN_PROGRESS",
        "a booking is in progress for this referral: finish or withdraw it first",
      );
  }

  private async resolveException(
    c: DbClient,
    ctx: Ctx,
    caseRow: CaseRow,
    r: ReferralRow,
    action: Extract<CaseAction, { action: "resolve_exception" }>,
  ): Promise<{ caseRow: CaseRow; executionId?: string | null }> {
    const item = await c.query<{
      id: string;
      kind: WorkItemKind;
      status: string;
    }>(
      "SELECT id,kind,status FROM work_items WHERE tenant_id=$1 AND case_id=$2 AND id=$3 FOR UPDATE",
      [ctx.tenantId, caseRow.id, action.work_item_id],
    );
    const w = item.rows[0];
    if (!w) throw notFound("work item");
    if (w.status !== "OPEN")
      throw conflict("WORK_ITEM_RESOLVED", "work item is already resolved");
    const allowed: Record<typeof action.resolution, WorkItemKind[]> = {
      safety_reviewed: ["SAFETY"],
      file_reviewed: ["FILE_SAFETY"],
      acknowledge: ["OUTCOME_REVIEW", "FOLLOW_UP", "ESCALATION"],
      retry_destination: ["CONNECTOR", "MANUAL_DESTINATION"],
    };
    if (!allowed[action.resolution].includes(w.kind))
      throw conflict(
        "RESOLUTION_NOT_APPLICABLE",
        `${action.resolution} does not apply to ${w.kind}`,
      );
    if (action.resolution !== "retry_destination") {
      await resolveWorkItems(c, ctx, caseRow, {
        id: w.id,
        resolution: action.resolution,
        note: action.note,
        staffSeconds: action.staff_seconds,
      });
      return { caseRow };
    }
    if (caseRow.current_state !== "EXCEPTION")
      throw this.notApplicable("retry_destination", caseRow.current_state);
    const ruleSet = await this.pinnedRuleSet(c, ctx.tenantId, r);
    if (ruleSet.definition.destination.mode !== "CONNECTOR")
      throw conflict(
        "DESTINATION_MANUAL",
        "this organisation uses the manual destination workflow",
      );
    if (
      (await this.openKinds(c, ctx.tenantId, caseRow.id)).some((k) =>
        SAFETY_HOLDS.includes(k),
      )
    )
      throw conflict(
        "SAFETY_REVIEW_REQUIRED",
        "resolve the safety review first",
      );
    const executions = await caseExecutions(c, ctx.tenantId, caseRow.id);
    if (executions.some(executionInFlight))
      throw conflict(
        "EXECUTION_IN_FLIGHT",
        "an automated destination action is still in progress",
      );
    const unknown = executions.filter(executionUnresolved);
    if (unknown.length && !action.attest_not_committed)
      throw conflict(
        "ATTESTATION_REQUIRED",
        "a previous write may have reached the destination; confirm it is absent there before retrying",
      );
    for (const e of unknown)
      await c.query(
        "UPDATE executions SET superseded_at=now(),superseded_by=$3,superseded_reason='staff_attested_not_committed' WHERE tenant_id=$1 AND id=$2",
        [ctx.tenantId, e.id, ctx.actor.id],
      );
    await resolveWorkItems(c, ctx, caseRow, {
      kinds: ["CONNECTOR", "MANUAL_DESTINATION"],
      resolution: "retry_destination",
      note: action.note,
      staffSeconds: action.staff_seconds,
    });
    const row = await transitionCase(c, ctx, caseRow, {
      to: "DESTINATION_PENDING",
      reason: "staff_retry_destination",
      owner: "SYSTEM",
      details: { attested_not_committed: unknown.map((e) => e.id) },
    });
    const executionId = await enqueueDestination(c, ctx, row, {
      operation: "referral.create",
      subject: { type: "referral", id: r.id },
      payload: { referral_id: r.id },
    });
    return { caseRow: row, executionId };
  }

  /** Shared by the manual path here and the connector path in the worker. */
  private async enterReadyForBooking(
    c: DbClient,
    ctx: Ctx,
    caseRow: CaseRow,
    r: ReferralRow,
    input: { source: "STAFF"; reference: string },
  ): Promise<{ caseRow: CaseRow }> {
    const ruleSet = await this.pinnedRuleSet(c, ctx.tenantId, r);
    await c.query(
      "UPDATE referrals SET follow_up_due_at=now()+($3||' hours')::interval WHERE tenant_id=$1 AND id=$2",
      [
        ctx.tenantId,
        r.id,
        ruleSet.definition.follow_up.ready_for_booking_hours,
      ],
    );
    let row = await transitionCase(c, ctx, caseRow, {
      to: "READY_FOR_BOOKING",
      reason: "destination_reference_recorded",
      owner: "REFERRAL_COORDINATOR",
      details: {
        destination_source: "MANUAL",
        destination_reference: input.reference,
      },
    });
    await recordMilestone(c, ctx, row, "DESTINATION_COMMITTED", {
      sourceType: input.source,
      verificationLevel: "HUMAN_ATTESTED",
      actorId: ctx.actor.id,
      payload: { destination_source: "MANUAL" },
    });
    row = await applyPendingObservations(c, ctx, row);
    return { caseRow: row };
  }

  // -------------------------------------------------------------------------
  // Appointment operations
  // -------------------------------------------------------------------------

  /** A step of the booking sub-flow on an appointment operations case. */
  async performAppointmentAction(
    auth: AuthContext,
    caseId: string,
    action: AppointmentAction,
  ) {
    authorize(auth.role, "appointment.book");
    const envelope: CommandEnvelope = {
      tenantId: auth.tenantId,
      commandId: action.command_id,
      type: "appointment.action",
      requestHash: requestHash({
        type: "appointment.action",
        case_id: caseId,
        ...action,
        command_id: undefined,
        correlation_id: undefined,
      }),
      actor: auth.actor,
      caseId,
      subject: { type: "case", id: caseId },
    };
    const ctx: Ctx = {
      tenantId: auth.tenantId,
      correlationId: action.correlation_id,
      actor: auth.actor,
    };
    return this.tx(auth, (c) =>
      executeCommand(c, envelope, () =>
        this.appointments.act(c, ctx, auth.role, caseId, action),
      ),
    );
  }

  /** Confirm, reschedule or cancel a committed appointment. */
  async changeAppointment(
    auth: AuthContext,
    appointmentId: string,
    change: AppointmentChange,
  ) {
    const envelope: CommandEnvelope = {
      tenantId: auth.tenantId,
      commandId: change.command_id,
      type: "appointment.change",
      requestHash: requestHash({
        type: "appointment.change",
        appointment_id: appointmentId,
        ...change,
        command_id: undefined,
        correlation_id: undefined,
      }),
      actor: auth.actor,
    };
    const ctx: Ctx = {
      tenantId: auth.tenantId,
      correlationId: change.correlation_id,
      actor: auth.actor,
    };
    return this.tx(auth, (c) =>
      executeCommand(c, envelope, () =>
        this.appointments.change(c, ctx, auth.role, appointmentId, change),
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Legacy v1 resolve endpoint
  // -------------------------------------------------------------------------

  async legacyResolve(
    auth: AuthContext,
    referralId: string,
    input: {
      command_id: string;
      correlation_id: string;
      expected_version: number;
      resolution: string;
      note: string;
    },
  ) {
    const found = await this.tx(auth, async (c) => {
      const row = await c.query<{ case_id: string }>(
        "SELECT case_id FROM referrals WHERE tenant_id=$1 AND id=$2",
        [auth.tenantId, referralId],
      );
      if (!row.rows[0]) throw notFound("referral");
      const items = await c.query<{ id: string; kind: string }>(
        "SELECT id,kind FROM work_items WHERE tenant_id=$1 AND case_id=$2 AND status='OPEN' AND kind IN ('CONNECTOR','MANUAL_DESTINATION') ORDER BY created_at",
        [auth.tenantId, row.rows[0].case_id],
      );
      return {
        caseId: row.rows[0].case_id,
        destinationItem: items.rows[0]?.id,
      };
    });
    const base = {
      command_id: input.command_id,
      correlation_id: input.correlation_id,
      expected_version: input.expected_version,
      note: input.note,
    };
    const action: CaseAction =
      input.resolution === "confirm_identity"
        ? { action: "confirm_identity", ...base }
        : input.resolution === "provide_insurance"
          ? { action: "provide_information", ...base, documents: ["insurance"] }
          : input.resolution === "reject"
            ? { action: "reject", ...base, resolution_code: "INVALID_REFERRAL" }
            : {
                action: "resolve_exception",
                ...base,
                work_item_id: found.destinationItem ?? randomUUID(),
                resolution: "retry_destination",
                attest_not_committed: false,
              };
    return this.performAction(auth, found.caseId, action);
  }

  // -------------------------------------------------------------------------
  // Outcome import (report exported from the destination system)
  // -------------------------------------------------------------------------

  async importObservations(auth: AuthContext, input: ObservationImport) {
    authorize(auth.role, "observation.import");
    const envelope: CommandEnvelope = {
      tenantId: auth.tenantId,
      commandId: input.command_id,
      type: "observation.import",
      requestHash: requestHash({
        type: "observation.import",
        ...input,
        command_id: undefined,
        correlation_id: undefined,
      }),
      actor: auth.actor,
    };
    const ctx: Ctx = {
      tenantId: auth.tenantId,
      correlationId: input.correlation_id,
      actor: auth.actor,
    };
    return this.tx(auth, (c) =>
      executeCommand(c, envelope, async () => {
        const results: {
          case_id: string;
          observation_id: string;
          disposition: string;
          deduplicated: boolean;
        }[] = [];
        for (const row of input.rows) {
          const caseRow = await lockCase(c, auth.tenantId, row.case_id);
          assertCaseTypeEnabled(caseRow.case_type);
          referralOnly(caseRow.case_type, "imported outcomes");
          const result = await recordObservation(c, ctx, caseRow, {
            type: row.observation_type,
            occurredAt: new Date(row.occurred_at),
            sourceType: "IMPORT",
            sourceReference: row.source_reference,
            verificationLevel: "HUMAN_ATTESTED",
            actorId: auth.actor.id,
            payload: { source_label: input.source_label },
            ...(row.resolution_code
              ? { resolutionCode: row.resolution_code }
              : {}),
          });
          results.push({
            case_id: row.case_id,
            observation_id: result.observationId,
            disposition: result.plan.disposition,
            deduplicated: result.deduplicated,
          });
        }
        await this.audit(
          c,
          auth,
          input.correlation_id,
          "observation.import",
          "import",
          input.command_id,
          {
            rows: input.rows.length,
            source_label: input.source_label,
          },
        );
        return { imported: results.length, results };
      }),
    );
  }

  async audit(
    c: DbClient,
    auth: AuthContext,
    correlationId: string,
    action: string,
    targetType: string,
    targetId: string,
    payload: object,
  ) {
    await c.query(
      `INSERT INTO access_audit_log(tenant_id,actor_type,actor_id,actor_role,action,target_type,target_id,payload,correlation_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        auth.tenantId,
        auth.actor.type,
        auth.actor.id,
        auth.role,
        action,
        targetType,
        targetId,
        payload,
        correlationId,
      ],
    );
  }
  runInTenant<T>(auth: AuthContext, fn: (c: DbClient) => Promise<T>) {
    return this.tx(auth, fn);
  }
  commandInTenant<T extends object>(
    auth: AuthContext,
    envelope: CommandEnvelope,
    fn: (c: DbClient) => Promise<T>,
  ): Promise<Replayed<T>> {
    return this.tx(auth, (c) => executeCommand(c, envelope, () => fn(c)));
  }
}
