import type pg from "pg";
import { errorFields, log, type Metrics } from "@access/observability";

/** A unit of background work, run per tenant at a fixed cadence. */
export interface Job {
  name: string;
  /** 0: every cycle (queues); otherwise the minimum interval. */
  everyMs: number;
  run(tenantId: string): Promise<number>;
  /** Optional once-per-run step over all tenants (e.g. gauges). */
  after?(tenantIds: readonly string[]): Promise<void>;
}

/**
 * Runs the platform's background jobs across tenants. The worker login is
 * bound to one tenant per transaction (RLS), so every job runs per tenant.
 * A failing job or tenant is logged, counted and retried next cycle; it
 * never stops the others.
 */
export class JobRunner {
  private lastRun = new Map<string, number>();
  private tenantCache: { ids: string[]; at: number } | null = null;
  heartbeat = Date.now();

  constructor(
    private readonly pool: pg.Pool,
    private readonly jobs: readonly Job[],
    private readonly options: {
      tenantIds?: readonly string[] | undefined;
      metrics?: Metrics;
      now?: () => number;
    } = {},
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  async tenants(): Promise<string[]> {
    if (this.tenantCache && this.now() - this.tenantCache.at < 30_000)
      return this.tenantCache.ids;
    const rows = await this.pool.query<{ id: string }>(
      "SELECT id FROM organisations ORDER BY id",
    );
    const all = rows.rows.map((r) => r.id);
    const ids = this.options.tenantIds
      ? all.filter((t) => this.options.tenantIds!.includes(t))
      : all;
    this.tenantCache = { ids, at: this.now() };
    return ids;
  }

  /** One cycle. Returns true when a queue job found work (poll again soon). */
  async tick(): Promise<boolean> {
    const tenantIds = await this.tenants();
    let worked = false;
    for (const job of this.jobs) {
      const last = this.lastRun.get(job.name) ?? 0;
      if (job.everyMs && this.now() - last < job.everyMs) continue;
      this.lastRun.set(job.name, this.now());
      const started = Date.now();
      let handled = 0;
      for (const tenantId of tenantIds) {
        try {
          handled += await job.run(tenantId);
        } catch (e) {
          this.options.metrics?.inc("worker_job_errors_total", {
            job: job.name,
          });
          log("error", "worker_job_failed", {
            job: job.name,
            tenant_id: tenantId,
            ...errorFields(e),
          });
        }
      }
      if (job.after)
        try {
          await job.after(tenantIds);
        } catch (e) {
          this.options.metrics?.inc("worker_job_errors_total", {
            job: job.name,
          });
          log("error", "worker_job_failed", {
            job: job.name,
            ...errorFields(e),
          });
        }
      this.options.metrics?.observe(
        "worker_job_seconds",
        (Date.now() - started) / 1000,
        { job: job.name },
      );
      if (handled) {
        this.options.metrics?.inc(
          "worker_job_items_total",
          { job: job.name },
          handled,
        );
        if (!job.everyMs) worked = true;
      }
    }
    this.heartbeat = Date.now();
    return worked;
  }
}
