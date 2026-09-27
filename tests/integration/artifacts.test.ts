import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { ExtractionPort } from "../../apps/core-api/src/extraction.js";
import type { ArtifactScanner } from "../../apps/core-api/src/scanner.js";
import {
  b64,
  closePools,
  countFiles,
  databaseEnabled,
  ingest,
  ingestBody,
  newTenant,
  ownerPool,
  staff,
  tableCounts,
  testApi,
} from "../support/harness.js";

const EICAR =
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

describe.runIf(databaseEnabled)(
  "artifact failure boundaries leave no plaintext and no orphans",
  () => {
    afterAll(closePools);

    it("extraction throwing unexpectedly after storage removes the object", async () => {
      const extractor: ExtractionPort = {
        extract: async () => Promise.reject(new Error("extractor crashed")),
      };
      const t = await testApi({ extractor });
      try {
        const tenant = await newTenant();
        const res = await t.app.inject({
          method: "POST",
          url: "/v1/referrals",
          headers: staff(tenant),
          payload: ingestBody(),
        });
        expect(res.statusCode).toBe(500);
        expect(res.json()).toEqual({
          error: "INTERNAL",
          message: "internal error",
        });
        expect(await countFiles(t.artifactRoot)).toBe(0);
        expect((await tableCounts(tenant)).access_cases).toBe(0);
      } finally {
        await t.close();
      }
    });

    it("validation failing after storage removes the object", async () => {
      const t = await testApi();
      try {
        const tenant = await newTenant();
        const res = await t.app.inject({
          method: "POST",
          url: "/v1/referrals",
          headers: staff(tenant),
          payload: ingestBody({
            fixture: undefined,
            structured: {
              patient: {
                given_name: "S",
                family_name: "P",
                date_of_birth: "1980-02-30",
              },
              referrer: { name: "Dr" },
              documents: [],
            },
          }),
        });
        expect(res.statusCode).toBe(400);
        expect(await countFiles(t.artifactRoot)).toBe(0);
      } finally {
        await t.close();
      }
    });

    it("a conflict inside the transaction removes the object; a replay stores nothing", async () => {
      const t = await testApi();
      try {
        const tenant = await newTenant();
        const body = ingestBody();
        await t.app.inject({
          method: "POST",
          url: "/v1/referrals",
          headers: staff(tenant),
          payload: body,
        });
        expect(await countFiles(t.artifactRoot)).toBe(1);
        await t.app.inject({
          method: "POST",
          url: "/v1/referrals",
          headers: staff(tenant),
          payload: body,
        });
        const conflict = await t.app.inject({
          method: "POST",
          url: "/v1/referrals",
          headers: staff(tenant),
          payload: { ...ingestBody(), referral_id: body.referral_id },
        });
        expect(conflict.statusCode).toBe(409);
        expect(await countFiles(t.artifactRoot)).toBe(1);
      } finally {
        await t.close();
      }
    });

    it("a database failure after storage removes the object", async () => {
      const t = await testApi();
      try {
        const tenant = await newTenant();
        await ownerPool().query(
          "UPDATE access_rule_sets SET status='RETIRED',effective_to=now() WHERE tenant_id=$1",
          [tenant],
        );
        // Rule set exists at the pre-check but is gone at the transaction.
        const res = await t.app.inject({
          method: "POST",
          url: "/v1/referrals",
          headers: staff(tenant),
          payload: ingestBody(),
        });
        expect(res.statusCode).toBe(409);
        expect(await countFiles(t.artifactRoot)).toBe(0);
      } finally {
        await t.close();
      }
    });

    it("concurrent identical commands keep exactly one object", async () => {
      const t = await testApi();
      try {
        const tenant = await newTenant();
        const body = ingestBody();
        const results = await Promise.all(
          [1, 2, 3].map(() =>
            t.app.inject({
              method: "POST",
              url: "/v1/referrals",
              headers: staff(tenant),
              payload: body,
            }),
          ),
        );
        expect(results.map((r) => r.statusCode).sort()).toEqual([
          200, 200, 201,
        ]);
        expect(new Set(results.map((r) => r.json().case_id)).size).toBe(1);
        expect(await countFiles(t.artifactRoot)).toBe(1);
        expect((await tableCounts(tenant)).artifacts).toBe(1);
      } finally {
        await t.close();
      }
    });

    it("scanner rejection stores nothing, records the verdict and opens a file-safety exception", async () => {
      const t = await testApi();
      try {
        const tenant = await newTenant();
        const r = await ingest(t, tenant, { content_base64: b64(EICAR) });
        expect(r.state).toBe("EXCEPTION");
        expect(await countFiles(t.artifactRoot)).toBe(0);
        const artifact = await ownerPool().query(
          "SELECT object_key,scan_status,storage_backend FROM artifacts WHERE case_id=$1",
          [r.case_id],
        );
        expect(artifact.rows[0]).toEqual({
          object_key: null,
          scan_status: "REJECTED",
          storage_backend: "none",
        });
        const work = await ownerPool().query(
          "SELECT kind FROM work_items WHERE case_id=$1 AND status='OPEN'",
          [r.case_id],
        );
        expect(work.rows.map((w) => w.kind)).toEqual(["FILE_SAFETY"]);
      } finally {
        await t.close();
      }
    });

    it("scanner errors fail the upload closed with nothing persisted", async () => {
      const scanner: ArtifactScanner = {
        name: "broken",
        production: true,
        scan: async () => ({ status: "ERROR", scanner: "broken" }),
      };
      const t = await testApi({ scanner });
      try {
        const tenant = await newTenant();
        const res = await t.app.inject({
          method: "POST",
          url: "/v1/referrals",
          headers: staff(tenant),
          payload: ingestBody(),
        });
        expect(res.statusCode).toBe(503);
        expect(res.json().error).toBe("SCANNER_UNAVAILABLE");
        expect(await countFiles(t.artifactRoot)).toBe(0);
        expect((await tableCounts(tenant)).access_cases).toBe(0);
      } finally {
        await t.close();
      }
    });

    it("a supplementary upload that conflicts is cleaned up too", async () => {
      const t = await testApi();
      try {
        const tenant = await newTenant();
        const r = await ingest(t, tenant, { fixture: "missing-insurance" });
        const upload = (version: number) =>
          t.app.inject({
            method: "POST",
            url: `/v1/cases/${r.case_id}/interactions`,
            headers: staff(tenant),
            payload: {
              command_id: randomUUID(),
              correlation_id: randomUUID(),
              intent: "MISSING_INFORMATION",
              actor_type: "PATIENT",
              expected_version: version,
              artifact: {
                filename: "card.txt",
                media_type: "text/plain",
                content_base64: b64("synthetic card"),
                document_types: ["insurance"],
              },
            },
          });
        expect((await upload(r.version + 5)).statusCode).toBe(409);
        expect(await countFiles(t.artifactRoot)).toBe(1);
        expect((await upload(r.version)).statusCode).toBe(201);
        expect(await countFiles(t.artifactRoot)).toBe(2);
      } finally {
        await t.close();
      }
    });
  },
);
