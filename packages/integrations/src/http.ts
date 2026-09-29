import http from "node:http";
import https from "node:https";
import { DeliveryFailure } from "./errors.js";
import { publicOnlyLookup, type TargetPolicy } from "./net.js";

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}
export interface PostOptions {
  headers: Record<string, string>;
  timeoutMs: number;
  policy: TargetPolicy;
  /** Responses larger than this are truncated (default 64 KiB). */
  maxResponseBytes?: number;
}

/** Errors raised before a connection exists: nothing was sent. */
const NOT_SENT = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const TLS_CONFIGURATION =
  /^(CERT_|ERR_TLS_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_|HOSTNAME_MISMATCH|ERR_SSL_)/;

/**
 * POST a body and read the response, classifying every failure by whether
 * the request can have reached the server: a failure before the body was
 * flushed is TRANSIENT (not sent); one after it is AMBIGUOUS.
 */
export function postJson(
  url: URL,
  body: string,
  options: PostOptions,
): Promise<HttpResponse> {
  const transport = url.protocol === "https:" ? https : http;
  const limit = options.maxResponseBytes ?? 65_536;
  return new Promise((resolve, reject) => {
    let flushed = false;
    let settled = false;
    const fail = (e: DeliveryFailure) => {
      if (settled) return;
      settled = true;
      reject(e);
    };
    const req = transport.request(
      url,
      {
        method: "POST",
        headers: {
          ...options.headers,
          "content-length": Buffer.byteLength(body).toString(),
        },
        // Private targets are refused when the socket connects.
        ...(options.policy.allowInsecure ? {} : { lookup: publicOnlyLookup }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          if (size < limit) chunks.push(chunk.subarray(0, limit - size));
          size += chunk.length;
        });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", () =>
          fail(new DeliveryFailure("AMBIGUOUS", "RESPONSE_INTERRUPTED")),
        );
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      fail(
        flushed
          ? new DeliveryFailure("AMBIGUOUS", "RESPONSE_TIMEOUT")
          : new DeliveryFailure("TRANSIENT", "CONNECT_TIMEOUT"),
      );
    }, options.timeoutMs);
    req.on("finish", () => {
      flushed = true;
    });
    req.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const code = e.code ?? "NETWORK_ERROR";
      if (code === "EBLOCKEDADDRESS")
        return fail(new DeliveryFailure("CONFIGURATION", "TARGET_NOT_PUBLIC"));
      if (TLS_CONFIGURATION.test(code))
        return fail(
          new DeliveryFailure("CONFIGURATION", "TLS_VERIFICATION_FAILED"),
        );
      if (!flushed || NOT_SENT.has(code))
        return fail(new DeliveryFailure("TRANSIENT", `NOT_SENT_${code}`));
      return fail(new DeliveryFailure("AMBIGUOUS", `AFTER_SEND_${code}`));
    });
    req.end(body);
  });
}

/** Seconds from a Retry-After header (delta-seconds or HTTP date). */
export function retryAfterSeconds(
  value: string | string[] | undefined,
  now = Date.now(),
): number | null {
  const v = Array.isArray(value) ? value[0] : value;
  if (!v) return null;
  if (/^\d+$/.test(v.trim())) return Math.min(Number(v.trim()), 86_400);
  const at = Date.parse(v);
  return Number.isNaN(at)
    ? null
    : Math.max(0, Math.min(Math.ceil((at - now) / 1000), 86_400));
}
