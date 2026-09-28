import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Metrics } from "@access/observability";

export interface HealthOptions {
  port: number;
  host?: string;
  metrics: Metrics;
  /** Required for /metrics when set (always set in secure profiles). */
  metricsToken: string | undefined;
  /** Liveness: the work loop has completed a cycle recently. */
  live: () => boolean;
  /** Readiness: the database answers. */
  ready: () => Promise<boolean>;
  build: string;
}

function bearerMatches(header: string | undefined, token: string): boolean {
  const given = Buffer.from(/^Bearer (.+)$/.exec(header ?? "")?.[1] ?? "");
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * The worker's operational endpoints (Railway health checks and Prometheus
 * scraping). No business data is served here.
 */
export function startHealthServer(
  options: HealthOptions,
): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://worker");
    const json = (status: number, body: unknown) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "GET") return json(405, { error: "METHOD_NOT_ALLOWED" });
    if (url.pathname === "/health")
      return options.live()
        ? json(200, { status: "ok", build: options.build })
        : json(503, { status: "stalled", build: options.build });
    if (url.pathname === "/ready") {
      options
        .ready()
        .then((ok) =>
          ok
            ? json(200, { status: "ready" })
            : json(503, { status: "not_ready" }),
        )
        .catch(() => json(503, { status: "not_ready" }));
      return;
    }
    if (url.pathname === "/metrics") {
      if (
        options.metricsToken &&
        !bearerMatches(req.headers.authorization, options.metricsToken)
      )
        return json(401, { error: "UNAUTHENTICATED" });
      res.writeHead(200, {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(options.metrics.renderPrometheus());
      return;
    }
    return json(404, { error: "NOT_FOUND" });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "0.0.0.0", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
