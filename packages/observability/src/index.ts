/**
 * Structured operational logging. Logs are for operators, not for patient
 * data: only allow-listed identifier/state/error fields are written. Any other
 * field is dropped, and known sensitive names are redacted even when nested.
 * tests/unit/logging.test.ts also checks every log call site statically.
 */
export const LOG_FIELD_ALLOWLIST = new Set([
  "tenant_id",
  "case_id",
  "referral_id",
  "execution_id",
  "correlation_id",
  "command_id",
  "work_item_id",
  "observation_id",
  "object_key",
  "state",
  "from_state",
  "to_state",
  "status",
  "status_code",
  "code",
  "error_code",
  "error_name",
  "method",
  "route",
  "duration_ms",
  "retry_attempt",
  "attempts",
  "queue_age_ms",
  "delay_ms",
  "count",
  "operation",
  "capability",
  "observation_type",
  "disposition",
  "profile",
  "data_mode",
  "auth_mode",
  "runtime",
  "build",
  "port",
  "worked",
]);
/** Never logged, at any depth, even if someone adds them to the allowlist. */
export const SENSITIVE_FIELDS = new Set([
  "given_name",
  "family_name",
  "name",
  "patient",
  "date_of_birth",
  "dob",
  "id_number",
  "identity_number",
  "passport",
  "passport_number",
  "medical_aid_number",
  "member_number",
  "scheme",
  "reason",
  "note",
  "notes",
  "extraction",
  "structured",
  "content",
  "content_base64",
  "payload",
  "body",
  "authorization",
  "token",
  "password",
  "destination_reference",
  "external_id",
]);
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        SENSITIVE_FIELDS.has(k.toLowerCase()) ? "[REDACTED]" : redact(v),
      ]),
    );
  return value;
}
export function sanitizeFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_FIELDS.has(key.toLowerCase())) out[key] = "[REDACTED]";
    else if (!LOG_FIELD_ALLOWLIST.has(key)) out[key] = "[DROPPED]";
    else out[key] = redact(value);
  }
  return out;
}

export type LogSink = (line: string) => void;
let sink: LogSink = (line) => process.stdout.write(line + "\n");
/** Tests capture output through this hook. */
export function setLogSink(next: LogSink): LogSink {
  const previous = sink;
  sink = next;
  return previous;
}
export function log(
  level: "info" | "warn" | "error",
  message: string,
  fields: Record<string, unknown> = {},
): void {
  sink(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...sanitizeFields(fields),
    }),
  );
}
/** Error details safe to log: class name and a stable code, never messages. */
export function errorFields(error: unknown): Record<string, unknown> {
  const e = error as { name?: unknown; code?: unknown; statusCode?: unknown };
  return {
    error_name: typeof e?.name === "string" ? e.name : "Error",
    error_code: typeof e?.code === "string" ? e.code : null,
    ...(typeof e?.statusCode === "number" ? { status_code: e.statusCode } : {}),
  };
}

export class Metrics {
  private values = new Map<string, number>();
  inc(name: string): void {
    this.values.set(name, (this.values.get(name) ?? 0) + 1);
  }
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.values);
  }
}
