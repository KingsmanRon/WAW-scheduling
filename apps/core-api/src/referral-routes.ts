import {
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  referralDocumentSchema,
  referralListQuerySchema,
  referralSchema,
  rejectReferralSchema,
  verifyReferralSchema,
  versionedSchema,
} from "@access/contracts";
import { AppError, recordAuditEvent } from "@access/db";
import { log } from "@access/observability";
import { practiceCan } from "@access/policy";
import {
  cancelReferral,
  createReferral,
  getReferral,
  getReferralDocument,
  inPracticeTransaction,
  listReferrals,
  recordReferralDocument,
  rejectReferral,
  verifyReferral,
} from "@access/scheduling";
import { decodeArtifact } from "./service.js";
import type { ArtifactScanner } from "./scanner.js";
import type { ArtifactStore } from "./storage.js";
import {
  createPracticeKit,
  idParam,
  requestMeta,
  type PracticeRouteDeps,
} from "./route-kit.js";

/**
 * The referral register and its private documents. Referral letters are
 * clinical content: they are scanned before storage, stored only as
 * AES-256-GCM ciphertext in a private bucket, and read back only through
 * short-lived links signed here (bound to one document, one user and one
 * minute, re-checked against the user's current membership when used, and
 * audited on issue and on download). Registering a referral does not imply
 * reading it: receptionists record and upload; clinicians and
 * administrators read.
 */
export interface ReferralDocumentDeps {
  store: ArtifactStore;
  scanner: ArtifactScanner;
  /** Key for download links (derive with downloadLinkKey). */
  linkKey: Buffer;
  retentionDays: number;
  linkTtlSeconds?: number;
}
export interface ReferralRouteDeps extends PracticeRouteDeps {
  /** null: document upload and download are unavailable. */
  documents: ReferralDocumentDeps | null;
}

/** A key for download links, separate from (but derived from) the storage key. */
export function downloadLinkKey(encryptionKey: Buffer): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      encryptionKey,
      Buffer.alloc(0),
      "access/referral-document-links/v1",
      32,
    ),
  );
}

interface LinkClaims {
  /** tenant, practice, referral, document, actor, actor role, expiry (s). */
  t: string;
  p: string;
  r: string;
  d: string;
  u: string;
  ur: string | null;
  e: number;
  n: string;
}
const b64url = (b: Buffer) => b.toString("base64url");
export function signDownloadLink(key: Buffer, claims: LinkClaims): string {
  const payload = b64url(Buffer.from(JSON.stringify(claims)));
  const signature = b64url(
    createHmac("sha256", key).update(`v1.${payload}`).digest(),
  );
  return `v1.${payload}.${signature}`;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function verifyDownloadLink(
  key: Buffer,
  token: string,
  nowSeconds: number,
): LinkClaims | null {
  const m = /^v1\.([A-Za-z0-9_-]{10,2000})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return null;
  // Compare the canonical encoding, not decoded bytes: the last of the 43
  // characters carries two unused bits, so decoding would accept several
  // spellings of one signature.
  const expected = Buffer.from(
    b64url(createHmac("sha256", key).update(`v1.${m[1]}`).digest()),
  );
  const given = Buffer.from(m[2]!);
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return null;
  let claims: LinkClaims;
  try {
    claims = JSON.parse(Buffer.from(m[1]!, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    typeof claims.e !== "number" ||
    claims.e <= nowSeconds ||
    ![claims.t, claims.p, claims.r, claims.d].every(
      (v) => typeof v === "string" && UUID.test(v),
    ) ||
    typeof claims.u !== "string"
  )
    return null;
  return claims;
}

/** The declared type must match the file's own signature. */
function assertMediaType(bytes: Buffer, mediaType: string) {
  const starts = (sig: number[]) =>
    bytes.length >= sig.length && sig.every((b, i) => bytes[i] === b);
  const ok =
    mediaType === "application/pdf"
      ? starts([0x25, 0x50, 0x44, 0x46, 0x2d])
      : mediaType === "image/jpeg"
        ? starts([0xff, 0xd8, 0xff])
        : mediaType === "image/png"
          ? starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
          : (() => {
              if (bytes.includes(0)) return false;
              try {
                new TextDecoder("utf-8", { fatal: true }).decode(bytes);
                return true;
              } catch {
                return false;
              }
            })();
  if (!ok)
    throw new AppError(
      422,
      "DOCUMENT_TYPE_MISMATCH",
      "the file content does not match its declared type",
    );
}
const EXTENSION: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "text/plain": "txt",
};

export async function registerReferralRoutes(
  app: FastifyInstance,
  deps: ReferralRouteDeps,
): Promise<void> {
  const base = "/v1/practices/:practiceId/referrals";
  const { authorize, context, read, mutate } = createPracticeKit(deps);

  app.get(base, async (req) => {
    const auth = await authorize(req, "referral.read");
    const q = referralListQuerySchema.parse(req.query);
    return {
      items: await read(req, auth, (c, ctx) =>
        listReferrals(c, ctx, {
          patientId: q.patient_id,
          status: q.status,
          limit: q.limit,
        }),
      ),
    };
  });
  app.post(base, async (req, reply) => {
    const auth = await authorize(req, "referral.register");
    const body = referralSchema.parse(req.body);
    const ctx = context(req, auth, body.channel ?? "INTERNAL");
    return mutate(req, reply, auth, "referral.create", body, ctx, async (c) => {
      const id = await createReferral(c, ctx, {
        patientId: body.patient_id,
        referringPractitionerName: body.referring_practitioner_name,
        referringPracticeName: body.referring_practice_name,
        referringPracticeNumber: body.referring_practice_number,
        referralDate: body.referral_date,
        validUntil: body.valid_until,
        appointmentTypeId: body.appointment_type_id,
        maxAppointments: body.max_appointments,
      });
      return {
        status: 201,
        body: await getReferral(c, ctx, id),
        resourceType: "referral",
        resourceId: id,
      };
    });
  });
  app.get(`${base}/:referralId`, async (req) => {
    const auth = await authorize(req, "referral.read");
    const id = idParam(req, "referralId");
    return read(req, auth, (c, ctx) => getReferral(c, ctx, id));
  });
  app.post(`${base}/:referralId/verify`, async (req, reply) => {
    const auth = await authorize(req, "referral.verify");
    const id = idParam(req, "referralId");
    const body = verifyReferralSchema.parse(req.body);
    const ctx = context(req, auth);
    return mutate(
      req,
      reply,
      auth,
      "referral.verify",
      { id, body },
      ctx,
      async (c) => {
        await verifyReferral(c, ctx, id, {
          expectedVersion: body.expected_version,
          validUntil: body.valid_until,
          appointmentTypeId: body.appointment_type_id,
          maxAppointments: body.max_appointments,
        });
        return { status: 200, body: await getReferral(c, ctx, id) };
      },
    );
  });
  app.post(`${base}/:referralId/reject`, async (req, reply) => {
    const auth = await authorize(req, "referral.verify");
    const id = idParam(req, "referralId");
    const body = rejectReferralSchema.parse(req.body);
    const ctx = context(req, auth);
    return mutate(
      req,
      reply,
      auth,
      "referral.reject",
      { id, body },
      ctx,
      async (c) => {
        await rejectReferral(c, ctx, id, {
          reasonCode: body.reason_code,
          expectedVersion: body.expected_version,
        });
        return { status: 200, body: await getReferral(c, ctx, id) };
      },
    );
  });
  app.post(`${base}/:referralId/cancel`, async (req, reply) => {
    const auth = await authorize(req, "referral.verify");
    const id = idParam(req, "referralId");
    const body = versionedSchema.parse(req.body);
    const ctx = context(req, auth);
    return mutate(
      req,
      reply,
      auth,
      "referral.cancel",
      { id, body },
      ctx,
      async (c) => {
        await cancelReferral(c, ctx, id, {
          expectedVersion: body.expected_version,
        });
        return { status: 200, body: await getReferral(c, ctx, id) };
      },
    );
  });

  // -----------------------------------------------------------------------
  // Documents
  // -----------------------------------------------------------------------

  const documents = () => {
    if (!deps.documents)
      throw new AppError(
        503,
        "DOCUMENTS_UNAVAILABLE",
        "referral documents are not configured",
      );
    return deps.documents;
  };

  app.post(`${base}/:referralId/documents`, async (req, reply) => {
    const auth = await authorize(req, "referral.register");
    const referralId = idParam(req, "referralId");
    const body = referralDocumentSchema.parse(req.body);
    const docs = documents();
    const bytes = decodeArtifact(body.content_base64);
    if (bytes.length > 10 * 1024 * 1024)
      throw new AppError(400, "ARTIFACT_SIZE", "documents are at most 10 MiB");
    assertMediaType(bytes, body.media_type);
    const ctx = context(req, auth);
    // The fingerprint names the content by digest: a retry of the same
    // upload replays; the same key with other content is refused.
    const material = {
      referralId,
      document_type: body.document_type,
      media_type: body.media_type,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    return mutate(
      req,
      reply,
      auth,
      "referral.document.upload",
      material,
      ctx,
      async (c) => {
        // Nothing is scanned or stored for a referral that cannot take it.
        const referral = await getReferral(c, ctx, referralId);
        if (referral.status !== "RECEIVED" && referral.status !== "VERIFIED")
          throw new AppError(
            409,
            "REFERRAL_CLOSED",
            "documents can only be added to an open referral",
          );
        const scan = await docs.scanner.scan(bytes);
        if (scan.status === "REJECTED")
          throw new AppError(
            422,
            "DOCUMENT_REJECTED",
            "the file failed malware scanning and was not stored",
          );
        if (scan.status !== "CLEAN")
          throw new AppError(
            503,
            "SCANNER_UNAVAILABLE",
            "the file could not be scanned; try again later",
          );
        const stored = await docs.store.put({
          tenantId: ctx.tenantId,
          caseId: referralId,
          bytes,
          contentType: body.media_type,
        });
        try {
          const doc = await recordReferralDocument(c, ctx, referralId, {
            documentType: body.document_type,
            mediaType: body.media_type,
            sizeBytes: stored.size,
            digestSha256: stored.digest,
            storageBackend: stored.backend,
            objectKey: stored.objectKey,
            encryptionKeyId: stored.keyId,
            scanner: scan.scanner,
            scannedAt: new Date(),
            retentionUntil: new Date(
              Date.now() + docs.retentionDays * 24 * 3600_000,
            ),
          });
          if (!doc.created)
            await docs.store.remove(stored.objectKey).catch(() => undefined);
          return {
            status: doc.created ? 201 : 200,
            body: {
              document: {
                id: doc.id,
                referral_id: referralId,
                document_type: body.document_type,
                media_type: body.media_type,
                size_bytes: stored.size,
              },
              created: doc.created,
            },
            resourceType: "referral_document",
            resourceId: doc.id,
          };
        } catch (e) {
          await docs.store.remove(stored.objectKey).catch(() => undefined);
          throw e;
        }
      },
    );
  });

  app.post(
    `${base}/:referralId/documents/:documentId/link`,
    async (req, reply) => {
      const auth = await authorize(req, "referral.document.read");
      const referralId = idParam(req, "referralId");
      const documentId = idParam(req, "documentId");
      const docs = documents();
      const ttl = docs.linkTtlSeconds ?? 60;
      const ctx = context(req, auth);
      const expires = Math.floor(Date.now() / 1000) + ttl;
      await inPracticeTransaction(deps.pool, ctx, async (c) => {
        await getReferralDocument(c, ctx, documentId, referralId);
        await recordAuditEvent(c, {
          tenantId: ctx.tenantId,
          practiceId: ctx.practiceId,
          actor: ctx.actor,
          action: "referral_document.link_issued",
          resourceType: "referral_document",
          resourceId: documentId,
          channel: "INTERNAL",
          changes: {
            after: { expires_at: new Date(expires * 1000).toISOString() },
          },
          request: requestMeta(req),
        });
      });
      const token = signDownloadLink(docs.linkKey, {
        t: ctx.tenantId,
        p: ctx.practiceId,
        r: referralId,
        d: documentId,
        u: ctx.actor.id,
        ur: ctx.actor.role,
        e: expires,
        n: randomBytes(8).toString("hex"),
      });
      return reply.header("cache-control", "no-store").send({
        url: `/v1/referral-documents/download?token=${token}`,
        expires_at: new Date(expires * 1000).toISOString(),
      });
    },
  );

  // The link itself is the credential (a browser tab cannot send a bearer
  // token); it is short-lived and the user's access is checked again.
  app.get("/v1/referral-documents/download", async (req, reply) => {
    const docs = documents();
    const query = req.query as Record<string, unknown>;
    const token = typeof query.token === "string" ? query.token : "";
    const claims = verifyDownloadLink(
      docs.linkKey,
      token,
      Math.floor(Date.now() / 1000),
    );
    const denied = () =>
      reply.code(403).header("cache-control", "no-store").send({
        error: "LINK_INVALID",
        message: "the link is invalid or expired",
      });
    if (!claims) return denied();
    const role = await deps.authenticator.currentPracticeRole(
      {
        id: claims.u,
        role: (claims.ur as Parameters<typeof practiceCan>[0]) ?? null,
      },
      claims.t,
      claims.p,
    );
    if (!role || !practiceCan(role, "referral.document.read")) return denied();
    const actor = { type: "STAFF" as const, id: claims.u, role };
    const doc = await inPracticeTransaction(
      deps.pool,
      { tenantId: claims.t, practiceId: claims.p, actor },
      async (c) => {
        const d = await getReferralDocument(
          c,
          { tenantId: claims.t, practiceId: claims.p },
          claims.d,
          claims.r,
        );
        await recordAuditEvent(c, {
          tenantId: claims.t,
          practiceId: claims.p,
          actor,
          action: "referral_document.downloaded",
          resourceType: "referral_document",
          resourceId: d.id,
          channel: "INTERNAL",
          changes: {},
          request: requestMeta(req),
        });
        return d;
      },
    );
    const bytes = await docs.store.get(doc.objectKey);
    if (createHash("sha256").update(bytes).digest("hex") !== doc.digestSha256) {
      log("error", "referral_document_integrity", {
        practice_id: claims.p,
        request_id: String(req.id),
      });
      throw new AppError(
        500,
        "DOCUMENT_INTEGRITY",
        "the stored document failed its integrity check",
      );
    }
    return reply
      .header("content-type", doc.mediaType)
      .header(
        "content-disposition",
        `attachment; filename="referral-${doc.id}.${EXTENSION[doc.mediaType] ?? "bin"}"`,
      )
      .header("cache-control", "no-store, private")
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("cross-origin-resource-policy", "same-origin")
      .send(bytes);
  });
}
