import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

/**
 * A local stand-in for the Meta Graph API (WhatsApp Cloud API) used by the
 * automated tests: the production adapter talks HTTP to it exactly as it
 * would to graph.facebook.com. It checks the bearer token, records every
 * request and answers with the documented response shapes; tests script
 * failures (rate limits, refusals, hangs) per request.
 */
export interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}
interface Scripted {
  status: number;
  body: unknown;
  delayMs?: number;
  headers?: Record<string, string>;
}

export class GraphApiFixture {
  readonly requests: RecordedRequest[] = [];
  private scripted: Scripted[] = [];
  private server: http.Server | undefined;
  url = "";
  constructor(readonly accessToken: string) {}

  /** Handles one Graph API request (also mounted by the browser suite's server). */
  readonly handle = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        body = {};
      }
      this.requests.push({
        method: req.method ?? "",
        path: req.url ?? "",
        authorization: req.headers.authorization,
        body,
      });
      const reply = (s: Scripted) => {
        const send = () => {
          if (res.destroyed) return;
          res.writeHead(s.status, {
            "content-type": "application/json",
            ...s.headers,
          });
          res.end(JSON.stringify(s.body));
        };
        if (s.delayMs) setTimeout(send, s.delayMs);
        else send();
      };
      if (req.headers.authorization !== `Bearer ${this.accessToken}`)
        return reply({
          status: 401,
          body: {
            error: {
              message: "Error validating access token",
              type: "OAuthException",
              code: 190,
              fbtrace_id: "fixture",
            },
          },
        });
      const next = this.scripted.shift();
      if (next) return reply(next);
      if (body.status === "read")
        return reply({ status: 200, body: { success: true } });
      return reply({
        status: 200,
        body: {
          messaging_product: "whatsapp",
          contacts: [
            {
              input: String(body.to ?? ""),
              wa_id: String(body.to ?? ""),
            },
          ],
          messages: [
            {
              id: `wamid.${randomUUID().replace(/-/g, "")}`,
              message_status: "accepted",
            },
          ],
        },
      });
    });
  };

  async start(port = 0): Promise<void> {
    this.server = http.createServer(this.handle);
    await new Promise<void>((r) => this.server!.listen(port, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  /** The next request gets this answer instead of a success. */
  respond(scripted: Scripted): void {
    this.scripted.push(scripted);
  }
  /** A Graph API error body with the given code. */
  error(status: number, code: number, message = "fixture error"): void {
    this.respond({
      status,
      body: {
        error: {
          message: `(#${code}) ${message}`,
          type: "OAuthException",
          code,
          fbtrace_id: "fixture",
        },
      },
    });
  }
  messages(): RecordedRequest[] {
    return this.requests.filter(
      (r) =>
        r.body.messaging_product === "whatsapp" && r.body.status !== "read",
    );
  }
  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server!.close(() => r()));
  }
}
