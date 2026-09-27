import { connect } from "node:net";

/**
 * File-safety gate. Nothing is stored or extracted unless the scanner says
 * CLEAN. A scanner that cannot answer yields ERROR and the upload fails
 * closed; there is no "assume clean" path.
 */
export type ScanStatus = "PENDING" | "CLEAN" | "REJECTED" | "ERROR";
export interface ScanResult {
  status: Exclude<ScanStatus, "PENDING">;
  scanner: string;
  /** Scanner signature name for REJECTED; never file content. */
  signature?: string;
}
export interface ArtifactScanner {
  readonly name: string;
  /** False for scanners that do not detect malware (synthetic mode only). */
  readonly production: boolean;
  scan(bytes: Buffer): Promise<ScanResult>;
}

const EICAR =
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
/**
 * Explicit mock for SYNTHETIC development only. It recognises only the EICAR
 * test string so the rejection path can be exercised. Configuration refuses
 * it in REAL data mode and in client-pilot/production profiles.
 */
export class MockSyntheticScanner implements ArtifactScanner {
  readonly name = "mock-synthetic";
  readonly production = false;
  async scan(bytes: Buffer): Promise<ScanResult> {
    return bytes.includes(Buffer.from(EICAR))
      ? {
          status: "REJECTED",
          scanner: this.name,
          signature: "EICAR-Test-Signature",
        }
      : { status: "CLEAN", scanner: this.name };
  }
}

/**
 * ClamAV daemon over TCP using the INSTREAM protocol. Deploy clamd next to
 * the API (see infra/azure/main.bicep sidecar) and keep signatures updated.
 */
export class ClamAvScanner implements ArtifactScanner {
  readonly name = "clamav";
  readonly production = true;
  constructor(
    private options: { host: string; port?: number; timeoutMs?: number },
  ) {}
  scan(bytes: Buffer): Promise<ScanResult> {
    return new Promise((resolve) => {
      const done = (result: ScanResult) => {
        socket.destroy();
        resolve(result);
      };
      const error = () => done({ status: "ERROR", scanner: this.name });
      const socket = connect(this.options.port ?? 3310, this.options.host);
      socket.setTimeout(this.options.timeoutMs ?? 30_000, error);
      socket.on("error", error);
      let reply = "";
      socket.on("data", (chunk) => {
        reply += chunk.toString("utf8");
      });
      socket.on("end", () => {
        const text = reply.replace(/\0/g, "").trim();
        if (/^stream: OK$/.test(text))
          done({ status: "CLEAN", scanner: this.name });
        else {
          const found = /^stream: (.+) FOUND$/.exec(text);
          if (found)
            done({
              status: "REJECTED",
              scanner: this.name,
              signature: found[1]!.slice(0, 200),
            });
          else error();
        }
      });
      socket.on("connect", () => {
        socket.write("zINSTREAM\0");
        for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
          const chunk = bytes.subarray(offset, offset + 64 * 1024);
          const size = Buffer.alloc(4);
          size.writeUInt32BE(chunk.length);
          socket.write(size);
          socket.write(chunk);
        }
        socket.write(Buffer.alloc(4));
      });
    });
  }
}

export class ArtifactNotCleanError extends Error {
  readonly statusCode = 422;
  readonly code = "ARTIFACT_NOT_CLEAN";
}
/** Guard used before any extraction or processing of artifact bytes. */
export function assertClean(result: { status: ScanStatus }): void {
  if (result.status !== "CLEAN")
    throw new ArtifactNotCleanError(
      "artifact processing requires a CLEAN scan",
    );
}
