/**
 * The browser suite's stand-in for the Meta Graph API: the worker's
 * production WhatsApp adapter sends to it over HTTP. Specs read what a
 * patient's phone received from /__fixture/messages.
 */
import http from "node:http";
import { GraphApiFixture } from "../../support/graph-api-fixture.js";
import { PORTS, WHATSAPP } from "./env.js";

const fixture = new GraphApiFixture(WHATSAPP.token);
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://fixture");
  if (!url.pathname.startsWith("/__fixture/")) return fixture.handle(req, res);
  res.setHeader("content-type", "application/json");
  if (url.pathname === "/__fixture/health") return res.end("{}");
  if (url.pathname === "/__fixture/messages") {
    const to = url.searchParams.get("to");
    return res.end(
      JSON.stringify(
        fixture
          .messages()
          .filter((m) => !to || m.body.to === to)
          .map((m) => m.body),
      ),
    );
  }
  res.statusCode = 404;
  res.end("{}");
});
server.listen(PORTS.graph, "127.0.0.1", () =>
  process.stdout.write(`graph api fixture on ${PORTS.graph}\n`),
);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
