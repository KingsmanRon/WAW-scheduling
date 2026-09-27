import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";

/**
 * Artifact storage port. Every implementation stores only AES-256-GCM
 * ciphertext produced here (application-layer envelope encryption), under a
 * tenant-scoped key made of opaque UUIDs: no patient data in object names,
 * no plaintext at rest, no temporary plaintext files.
 */
export interface PutInput {
  tenantId: string;
  caseId: string;
  bytes: Buffer;
  contentType: string;
}
export interface StoredObject {
  objectKey: string;
  digest: string;
  size: number;
  keyId: string;
  backend: "local-encrypted" | "supabase-storage";
  objectVersion: string | null;
  created: boolean;
}
export interface ArtifactStore {
  readonly backend: StoredObject["backend"];
  put(input: PutInput): Promise<StoredObject>;
  get(objectKey: string): Promise<Buffer>;
  remove(objectKey: string): Promise<void>;
  /** Startup check (e.g. the bucket is private). */
  verify(): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `<tenant>/<case>/<random>.acv1` - opaque, tenant-prefixed, never reused. */
export function newObjectKey(tenantId: string, caseId: string): string {
  if (!UUID.test(tenantId) || !UUID.test(caseId))
    throw new Error("object keys are built from UUIDs only");
  return `${tenantId}/${caseId}/${randomUUID()}.acv1`;
}
const MAGIC = Buffer.from("ACV1");
/** Envelope: MAGIC | iv(12) | ciphertext | tag(16); AAD binds the object key. */
export function sealArtifact(
  key: Buffer,
  objectKey: string,
  plaintext: Buffer,
): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(objectKey));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, iv, body, cipher.getAuthTag()]);
}
export function openArtifact(
  key: Buffer,
  objectKey: string,
  sealed: Buffer,
): Buffer {
  const legacy =
    !sealed.subarray(0, 4).equals(MAGIC) || !objectKey.endsWith(".acv1");
  const offset = legacy ? 0 : 4;
  const iv = sealed.subarray(offset, offset + 12);
  const tag = sealed.subarray(sealed.length - 16);
  const body = sealed.subarray(offset + 12, sealed.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  if (!legacy) decipher.setAAD(Buffer.from(objectKey));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}
function digestOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Development/test store on the local filesystem (encrypted, 0600). */
export class LocalEncryptedArtifactStore implements ArtifactStore {
  readonly backend = "local-encrypted" as const;
  constructor(
    private root: string,
    private key: Buffer,
    private keyId = "local-aes-v1",
  ) {
    if (key.length !== 32) throw new Error("artifact key must be 32 bytes");
  }
  private path(objectKey: string): string {
    const full = normalize(join(this.root, objectKey));
    if (!full.startsWith(normalize(this.root) + sep))
      throw new Error("object key escapes the artifact root");
    return full;
  }
  async put(i: PutInput): Promise<StoredObject> {
    const objectKey = newObjectKey(i.tenantId, i.caseId);
    const path = this.path(objectKey);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, sealArtifact(this.key, objectKey, i.bytes), {
      mode: 0o600,
      flag: "wx",
    });
    return {
      objectKey,
      digest: digestOf(i.bytes),
      size: i.bytes.length,
      keyId: this.keyId,
      backend: this.backend,
      objectVersion: null,
      created: true,
    };
  }
  async get(objectKey: string): Promise<Buffer> {
    return openArtifact(
      this.key,
      objectKey,
      await readFile(this.path(objectKey)),
    );
  }
  async remove(objectKey: string) {
    try {
      await unlink(this.path(objectKey));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  async verify() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }
}
/** @deprecated name kept for the v1 unit tests; use LocalEncryptedArtifactStore. */
export const EncryptedFileStore = LocalEncryptedArtifactStore;

export class StorageError extends Error {
  readonly statusCode = 503;
  readonly code = "ARTIFACT_STORE_UNAVAILABLE";
}
/**
 * Supabase Storage (managed, S3-backed, encrypted at rest by the provider) in
 * a PRIVATE bucket, accessed only server-side with the service-role key. The
 * store never creates public or signed URLs.
 */
export class SupabaseStorageArtifactStore implements ArtifactStore {
  readonly backend = "supabase-storage" as const;
  constructor(
    private options: {
      url: string;
      bucket: string;
      serviceKey: string;
      encryptionKey: Buffer;
      keyId?: string;
      fetch?: typeof fetch;
    },
  ) {
    if (options.encryptionKey.length !== 32)
      throw new Error("artifact key must be 32 bytes");
  }
  private get http() {
    return this.options.fetch ?? fetch;
  }
  private headers(extra: Record<string, string> = {}) {
    return {
      authorization: `Bearer ${this.options.serviceKey}`,
      apikey: this.options.serviceKey,
      ...extra,
    };
  }
  private objectUrl(objectKey: string) {
    const path = objectKey.split("/").map(encodeURIComponent).join("/");
    return `${this.options.url.replace(/\/$/, "")}/storage/v1/object/${encodeURIComponent(this.options.bucket)}/${path}`;
  }
  async put(i: PutInput): Promise<StoredObject> {
    const objectKey = newObjectKey(i.tenantId, i.caseId);
    const response = await this.http(this.objectUrl(objectKey), {
      method: "POST",
      headers: this.headers({
        "content-type": "application/octet-stream",
        "x-upsert": "false",
        "cache-control": "no-store",
      }),
      body: new Uint8Array(
        sealArtifact(this.options.encryptionKey, objectKey, i.bytes),
      ),
    }).catch(() => {
      throw new StorageError("artifact store unreachable");
    });
    if (!response.ok)
      throw new StorageError(
        `artifact store rejected upload (${response.status})`,
      );
    const body = (await response.json().catch(() => ({}))) as {
      Id?: string;
      id?: string;
    };
    return {
      objectKey,
      digest: digestOf(i.bytes),
      size: i.bytes.length,
      keyId: this.options.keyId ?? "app-aes-v1",
      backend: this.backend,
      objectVersion: body.Id ?? body.id ?? null,
      created: true,
    };
  }
  async get(objectKey: string): Promise<Buffer> {
    const response = await this.http(this.objectUrl(objectKey), {
      headers: this.headers(),
    });
    if (!response.ok)
      throw new StorageError(`artifact read failed (${response.status})`);
    return openArtifact(
      this.options.encryptionKey,
      objectKey,
      Buffer.from(await response.arrayBuffer()),
    );
  }
  async remove(objectKey: string) {
    const response = await this.http(
      `${this.options.url.replace(/\/$/, "")}/storage/v1/object/${encodeURIComponent(this.options.bucket)}`,
      {
        method: "DELETE",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify({ prefixes: [objectKey] }),
      },
    );
    if (!response.ok && response.status !== 404)
      throw new StorageError(`artifact delete failed (${response.status})`);
  }
  /** Refuse to start against a public or missing bucket. */
  async verify() {
    const response = await this.http(
      `${this.options.url.replace(/\/$/, "")}/storage/v1/bucket/${encodeURIComponent(this.options.bucket)}`,
      { headers: this.headers() },
    );
    if (!response.ok)
      throw new StorageError(
        `artifact bucket unavailable (${response.status})`,
      );
    const bucket = (await response.json()) as { public?: boolean };
    if (bucket.public !== false)
      throw new StorageError("artifact bucket must be private");
  }
}
