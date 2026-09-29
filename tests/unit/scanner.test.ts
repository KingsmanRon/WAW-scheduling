import { describe, expect, it } from "vitest";
import { createServer, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import {
  ArtifactNotCleanError,
  assertClean,
  ClamAvScanner,
  MockSyntheticScanner,
} from "../../apps/core-api/src/scanner.js";
import { IntakeExtractor } from "../../apps/core-api/src/extraction.js";

const EICAR =
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

async function fakeClamd(respond: (payload: Buffer, socket: Socket) => void) {
  const server = createServer((socket) => {
    let data = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (
        data.length >= 4 &&
        data.subarray(data.length - 4).equals(Buffer.alloc(4))
      )
        respond(data.subarray(10, data.length - 4), socket);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port };
}

describe("artifact scanning", () => {
  it("mock scanner is explicit, non-production and rejects the EICAR test file", async () => {
    const s = new MockSyntheticScanner();
    expect(s.production).toBe(false);
    expect((await s.scan(Buffer.from("synthetic"))).status).toBe("CLEAN");
    expect((await s.scan(Buffer.from(EICAR))).status).toBe("REJECTED");
  });
  it("ClamAV INSTREAM: OK is CLEAN, FOUND is REJECTED with signature", async () => {
    const clean = await fakeClamd((_p, s) => s.end("stream: OK\0"));
    const infected = await fakeClamd((_p, s) =>
      s.end("stream: Eicar-Test-Signature FOUND\0"),
    );
    try {
      expect(
        await new ClamAvScanner({ host: "127.0.0.1", port: clean.port }).scan(
          Buffer.from("synthetic"),
        ),
      ).toEqual({ status: "CLEAN", scanner: "clamav" });
      expect(
        await new ClamAvScanner({
          host: "127.0.0.1",
          port: infected.port,
        }).scan(Buffer.from(EICAR)),
      ).toEqual({
        status: "REJECTED",
        scanner: "clamav",
        signature: "Eicar-Test-Signature",
      });
    } finally {
      clean.server.close();
      infected.server.close();
    }
  });
  it("streams content to clamd in length-prefixed chunks", async () => {
    let received: Buffer = Buffer.alloc(0);
    const fake = await fakeClamd((p, s) => {
      received = p;
      s.end("stream: OK\0");
    });
    try {
      await new ClamAvScanner({ host: "127.0.0.1", port: fake.port }).scan(
        Buffer.from("abc"),
      );
      expect(received.readUInt32BE(0)).toBe(3);
      expect(received.subarray(4).toString()).toBe("abc");
    } finally {
      fake.server.close();
    }
  });
  it("scanner errors, garbage and timeouts are ERROR (fail closed), never CLEAN", async () => {
    expect(
      (
        await new ClamAvScanner({ host: "127.0.0.1", port: 1 }).scan(
          Buffer.from("x"),
        )
      ).status,
    ).toBe("ERROR");
    const garbage = await fakeClamd((_p, s) =>
      s.end("stream: size limit exceeded. ERROR\0"),
    );
    const silent = await fakeClamd(() => undefined);
    try {
      expect(
        (
          await new ClamAvScanner({
            host: "127.0.0.1",
            port: garbage.port,
          }).scan(Buffer.from("x"))
        ).status,
      ).toBe("ERROR");
      expect(
        (
          await new ClamAvScanner({
            host: "127.0.0.1",
            port: silent.port,
            timeoutMs: 200,
          }).scan(Buffer.from("x"))
        ).status,
      ).toBe("ERROR");
    } finally {
      garbage.server.close();
      silent.server.close();
    }
  });
  it("extraction refuses anything that is not CLEAN", async () => {
    expect(() => assertClean({ status: "PENDING" })).toThrow(
      ArtifactNotCleanError,
    );
    const extractor = new IntakeExtractor({ fixturesAllowed: true });
    for (const status of ["PENDING", "REJECTED", "ERROR"] as const)
      await expect(
        extractor.extract({
          bytes: Buffer.from("x"),
          scan: { status } as never,
          fixture: "complete",
        }),
      ).rejects.toThrow(ArtifactNotCleanError);
  });
  it("fixture extraction is refused outside synthetic mode", async () =>
    expect(
      new IntakeExtractor({ fixturesAllowed: false }).extract({
        bytes: Buffer.from("x"),
        scan: { status: "CLEAN" },
        fixture: "complete",
      }),
    ).rejects.toMatchObject({
      code: "FIXTURE_REFUSED",
    }));
});
