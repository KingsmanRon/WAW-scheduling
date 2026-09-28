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
  // Scheduling platform.
  "service",
  "environment",
  "practice_id",
  "request_id",
  "actor_type",
  "actor_id",
  "appointment_id",
  "hold_id",
  "event_id",
  "event_type",
  "delivery_id",
  "message_id",
  "connection_id",
  "provider",
  "channel",
  "notification_type",
  "latency_ms",
  "lag_ms",
  "backoff_ms",
  "http_status",
  "limit",
  "failure_kind",
  "job",
  "skip_reason",
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

/** Fields stamped on every line of this process (service, environment, build). */
let processFields: Record<string, unknown> = {};
export function configureLogging(fields: {
  service: string;
  environment: string;
  build?: string;
}): void {
  processFields = {
    service: fields.service,
    environment: fields.environment,
    ...(fields.build ? { build: fields.build } : {}),
  };
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
      ...processFields,
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

type Labels = Record<string, string>;
const DEFAULT_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];
function labelKey(labels: Labels | undefined): string {
  if (!labels) return "";
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return entries
    .map(
      ([k, v]) =>
        `${k}="${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`,
    )
    .join(",");
}
const METRIC_NAME = /^[a-z_][a-z0-9_]*$/;
interface Histogram {
  buckets: number[];
  counts: number[];
  sum: number;
  count: number;
}
/**
 * Process metrics in the Prometheus text exposition format. Label values
 * are small closed vocabularies (route patterns, status codes, error codes,
 * event types) - never identifiers of patients, appointments or tenants.
 */
export class Metrics {
  private counters = new Map<string, Map<string, number>>();
  private gauges = new Map<string, Map<string, number>>();
  private histograms = new Map<string, Map<string, Histogram>>();
  private help = new Map<string, string>();
  constructor(private readonly prefix = "access_") {}
  describe(name: string, text: string): this {
    this.help.set(this.prefix + name, text);
    return this;
  }
  inc(name: string, labels?: Labels, value = 1): void {
    const series = this.series(this.counters, name);
    const key = labelKey(labels);
    series.set(key, (series.get(key) ?? 0) + value);
  }
  set(name: string, value: number, labels?: Labels): void {
    this.series(this.gauges, name).set(labelKey(labels), value);
  }
  /** Record a duration or size; seconds for durations. */
  observe(name: string, value: number, labels?: Labels): void {
    const series = this.series(this.histograms, name);
    const key = labelKey(labels);
    let h = series.get(key);
    if (!h) {
      h = {
        buckets: DEFAULT_BUCKETS,
        counts: DEFAULT_BUCKETS.map(() => 0),
        sum: 0,
        count: 0,
      };
      series.set(key, h);
    }
    h.sum += value;
    h.count += 1;
    h.buckets.forEach((b, i) => {
      if (value <= b) h!.counts[i]! += 1;
    });
  }
  private series<T>(store: Map<string, Map<string, T>>, name: string) {
    const full = this.prefix + name;
    if (!METRIC_NAME.test(full)) throw new Error(`invalid metric name ${name}`);
    let series = store.get(full);
    if (!series) {
      series = new Map();
      store.set(full, series);
    }
    return series;
  }
  /** Flat counter totals (legacy JSON view and tests). */
  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [name, series] of this.counters)
      for (const [labels, value] of series)
        out[labels ? `${name}{${labels}}` : name] = value;
    return out;
  }
  renderPrometheus(): string {
    const lines: string[] = [];
    const header = (name: string, type: string) => {
      const help = this.help.get(name);
      if (help) lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
    };
    const series = (name: string, labels: string, value: number) =>
      lines.push(`${name}${labels ? `{${labels}}` : ""} ${value}`);
    for (const [name, s] of this.counters) {
      header(name, "counter");
      for (const [labels, value] of s) series(name, labels, value);
    }
    for (const [name, s] of this.gauges) {
      header(name, "gauge");
      for (const [labels, value] of s) series(name, labels, value);
    }
    for (const [name, s] of this.histograms) {
      header(name, "histogram");
      for (const [labels, h] of s) {
        const join = (extra: string) => (labels ? `${labels},${extra}` : extra);
        h.buckets.forEach((b, i) =>
          series(`${name}_bucket`, join(`le="${b}"`), h.counts[i]!),
        );
        series(`${name}_bucket`, join('le="+Inf"'), h.count);
        series(`${name}_sum`, labels, h.sum);
        series(`${name}_count`, labels, h.count);
      }
    }
    return lines.join("\n") + "\n";
  }
}
