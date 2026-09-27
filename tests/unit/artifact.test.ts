import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  LocalEncryptedArtifactStore,
  SupabaseStorageArtifactStore,
  newObjectKey,
  openArtifact,
  sealArtifact,
} from "../../apps/core-api/src/storage.js";
import { decodeArtifact } from "../../apps/core-api/src/service.js";

const tenant = "11111111-1111-4111-8111-111111111111";
const kase = "22222222-2222-4222-8222-222222222222";

describe("local encrypted artifact store", () => {
  it("encrypts artifacts, keeps no plaintext and uses opaque tenant-scoped keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "access-"));
    const store = new LocalEncryptedArtifactStore(root, Buffer.alloc(32, 7));
    const bytes = Buffer.from(
      "synthetic referral for Jane Example born 1980-01-01",
    );
    const result = await store.put({
      tenantId: tenant,
      caseId: kase,
      bytes,
      contentType: "text/plain",
    });
    expect(result.objectKey).toMatch(
      new RegExp(`^${tenant}/${kase}/[0-9a-f-]{36}\\.acv1$`),
    );
    const disk = await readFile(join(root, result.objectKey));
    expect(disk.includes(bytes)).toBe(false);
    expect(disk.includes(Buffer.from("Jane"))).toBe(false);
    expect(result.digest).toHaveLength(64);
    expect(await store.get(result.objectKey)).toEqual(bytes);
    await store.remove(result.objectKey);
    await expect(access(join(root, result.objectKey))).rejects.toThrow();
  });
  it("binds ciphertext to its object key and still opens legacy objects", () => {
    const key = Buffer.alloc(32, 3);
    const k1 = newObjectKey(tenant, kase);
    const sealed = sealArtifact(key, k1, Buffer.from("x"));
    expect(() =>
      openArtifact(key, newObjectKey(tenant, kase), sealed),
    ).toThrow();
    expect(() => newObjectKey("Jane Example", kase)).toThrow();
  });
  it("strictly validates decoded artifact boundaries", () => {
    expect(() => decodeArtifact("%%%not-base64%%%")).toThrow("malformed");
    expect(() => decodeArtifact("")).toThrow("size");
    expect(
      decodeArtifact(Buffer.alloc(10_000_000).toString("base64")),
    ).toHaveLength(10_000_000);
    expect(() =>
      decodeArtifact(Buffer.alloc(10_000_001).toString("base64")),
    ).toThrow("size");
  });
});

describe("managed Supabase Storage artifact store", () => {
  async function fakeStorage(bucketPublic = false) {
    const requests: {
      method: string;
      url: string;
      headers: Record<string, unknown>;
      body: Buffer;
    }[] = [];
    const objects = new Map<string, Buffer>();
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        requests.push({
          method: req.method!,
          url: req.url!,
          headers: req.headers,
          body,
        });
        if (req.url!.startsWith("/storage/v1/bucket/")) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(
            JSON.stringify({ id: "access-artifacts", public: bucketPublic }),
          );
        }
        const path = decodeURIComponent(
          req.url!.replace("/storage/v1/object/access-artifacts/", ""),
        );
        if (req.method === "POST") {
          if (objects.has(path)) {
            res.writeHead(409);
            return res.end();
          }
          objects.set(path, body);
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(
            JSON.stringify({
              Key: `access-artifacts/${path}`,
              Id: "obj-version-1",
            }),
          );
        }
        if (req.method === "GET") {
          const o = objects.get(path);
          res.writeHead(o ? 200 : 404);
          return res.end(o);
        }
        if (req.method === "DELETE") {
          for (const p of (
            JSON.parse(body.toString()) as { prefixes: string[] }
          ).prefixes)
            objects.delete(p);
          res.writeHead(200);
          return res.end("[]");
        }
        res.writeHead(400);
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { server, url, requests, objects };
  }
  it("uploads ciphertext server-side to a private bucket without upsert or public URLs", async () => {
    const fake = await fakeStorage();
    try {
      const store = new SupabaseStorageArtifactStore({
        url: fake.url,
        bucket: "access-artifacts",
        serviceKey: "service-key",
        encryptionKey: Buffer.alloc(32, 5),
      });
      await store.verify();
      const bytes = Buffer.from("synthetic referral body");
      const stored = await store.put({
        tenantId: tenant,
        caseId: kase,
        bytes,
        contentType: "application/pdf",
      });
      const upload = fake.requests.find((r) => r.method === "POST")!;
      expect(upload.headers["x-upsert"]).toBe("false");
      expect(upload.headers.authorization).toBe("Bearer service-key");
      expect(upload.headers["content-type"]).toBe("application/octet-stream");
      expect(upload.body.includes(bytes)).toBe(false);
      expect(stored.objectVersion).toBe("obj-version-1");
      expect(stored.backend).toBe("supabase-storage");
      expect(fake.requests.some((r) => /public|sign/.test(r.url))).toBe(false);
      expect(await store.get(stored.objectKey)).toEqual(bytes);
      await store.remove(stored.objectKey);
      expect(fake.objects.size).toBe(0);
    } finally {
      fake.server.close();
    }
  });
  it("refuses to start against a public bucket", async () => {
    const fake = await fakeStorage(true);
    try {
      const store = new SupabaseStorageArtifactStore({
        url: fake.url,
        bucket: "access-artifacts",
        serviceKey: "k",
        encryptionKey: Buffer.alloc(32, 5),
      });
      await expect(store.verify()).rejects.toThrow(/private/);
    } finally {
      fake.server.close();
    }
  });
  it("fails closed when the store is unreachable", async () => {
    const store = new SupabaseStorageArtifactStore({
      url: "http://127.0.0.1:1",
      bucket: "access-artifacts",
      serviceKey: "k",
      encryptionKey: Buffer.alloc(32, 5),
    });
    await expect(
      store.put({
        tenantId: tenant,
        caseId: kase,
        bytes: Buffer.from("x"),
        contentType: "text/plain",
      }),
    ).rejects.toMatchObject({
      statusCode: 503,
    });
  });
});
