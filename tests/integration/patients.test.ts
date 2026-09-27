import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addPatientContact,
  createPatient,
  getPatientDetail,
  listDuplicateCandidates,
  patientsByPhone,
  reviewDuplicate,
  searchPatients,
  updatePatient,
} from "../../packages/patients/src/index.js";
import { closePools, databaseEnabled, ownerPool } from "../support/harness.js";
import {
  failure,
  hasher,
  newPractice,
  run,
  staffCtx,
  type TestPractice,
} from "../support/scheduling.js";

describe.runIf(databaseEnabled)("patient registry (PostgreSQL)", () => {
  let p: TestPractice;
  beforeAll(async () => {
    p = await newPractice();
  });
  afterAll(closePools);

  it("creates a patient with normalised contacts and a hashed national ID", async () => {
    const ctx = staffCtx(p);
    const created = await run(ctx, (c) =>
      createPatient(
        c,
        ctx,
        {
          givenName: " Thandi ",
          familyName: "Nkosi",
          dateOfBirth: "1980-01-01",
          sourceChannel: "WALK_IN",
          contacts: [
            { kind: "MOBILE", value: "082 555 0101" },
            { kind: "EMAIL", value: "Thandi@Example.org" },
          ],
          identifiers: [
            { system: "NATIONAL_ID", issuer: "ZA", value: "8001015009087" },
          ],
        },
        hasher,
      ),
    );
    expect(created.patient).toMatchObject({
      given_name: "Thandi",
      display_name: "Thandi Nkosi",
      primary_mobile: "+27825550101",
      primary_email: "thandi@example.org",
    });
    expect(created.patient.patient_number).toMatch(/^P\d{6}$/);
    const stored = await ownerPool().query(
      "SELECT value, value_hash, value_hint FROM directory.patient_identifiers WHERE patient_id=$1",
      [created.patient.id],
    );
    // The number itself is never stored.
    expect(stored.rows[0].value).toBeNull();
    expect(stored.rows[0].value_hint).toBe("9087");
    expect(JSON.stringify(stored.rows)).not.toContain("8001015009087");
    const detail = await run(ctx, (c) =>
      getPatientDetail(c, ctx, created.patient.id),
    );
    expect(detail.identifiers[0]).toMatchObject({
      system: "NATIONAL_ID",
      value: null,
      hint: "9087",
    });
    // The audit names changed fields, never their values.
    const audit = await ownerPool().query(
      "SELECT changes FROM platform.audit_events WHERE resource_id=$1",
      [created.patient.id],
    );
    expect(JSON.stringify(audit.rows)).not.toContain("Nkosi");
    // A second patient cannot claim the same identity number.
    expect(
      await failure(
        run(ctx, (c) =>
          createPatient(
            c,
            ctx,
            {
              givenName: "Other",
              familyName: "Person",
              sourceChannel: "PHONE",
              identifiers: [
                {
                  system: "NATIONAL_ID",
                  issuer: "ZA",
                  value: "800101 5009 087",
                },
              ],
            },
            hasher,
          ),
        ),
      ),
    ).toBe("PATIENT_IDENTIFIER_EXISTS");
  });

  it("finds patients by normalised phone, e-mail, number, identifier and name prefix", async () => {
    const ctx = staffCtx(p);
    const byPhone = await run(ctx, (c) =>
      searchPatients(c, ctx, { mobile: "+27 82 555 0101", limit: 10 }, hasher),
    );
    expect(byPhone.items.map((x) => x.family_name)).toEqual(["Nkosi"]);
    const byEmail = await run(ctx, (c) =>
      searchPatients(
        c,
        ctx,
        { email: "THANDI@example.org", limit: 10 },
        hasher,
      ),
    );
    expect(byEmail.items).toHaveLength(1);
    const byId = await run(ctx, (c) =>
      searchPatients(
        c,
        ctx,
        { nationalId: "8001015009087", limit: 10 },
        hasher,
      ),
    );
    expect(byId.items).toHaveLength(1);
    const byNumber = await run(ctx, (c) =>
      searchPatients(
        c,
        ctx,
        {
          patientNumber: byId.items[0]!.patient_number.toLowerCase(),
          limit: 10,
        },
        hasher,
      ),
    );
    expect(byNumber.items).toHaveLength(1);
    for (const text of ["nko", "thandi nk", "Nkosi, Th"]) {
      const byName = await run(ctx, (c) =>
        searchPatients(c, ctx, { text, limit: 10 }, hasher),
      );
      expect(
        byName.items.map((x) => x.id),
        text,
      ).toEqual([byId.items[0]!.id]);
    }
    expect(
      await failure(
        run(ctx, (c) => searchPatients(c, ctx, { limit: 10 }, hasher)),
      ),
    ).toBe("SEARCH_CRITERIA_REQUIRED");
  });

  it("paginates name searches with a keyset cursor", async () => {
    const ctx = staffCtx(p);
    for (let i = 0; i < 5; i++)
      await run(ctx, (c) =>
        createPatient(
          c,
          ctx,
          {
            givenName: `Page${i}`,
            familyName: "Paginated",
            sourceChannel: "PHONE",
          },
          hasher,
        ),
      );
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await run(ctx, (c) =>
        searchPatients(c, ctx, { text: "paginated", limit: 2, cursor }, hasher),
      );
      seen.push(...page.items.map((x) => x.given_name));
      cursor = page.next ?? undefined;
    } while (cursor);
    expect(seen).toEqual(["Page0", "Page1", "Page2", "Page3", "Page4"]);
  });

  it("flags possible duplicates for review and never merges them", async () => {
    const ctx = staffCtx(p);
    const a = await run(ctx, (c) =>
      createPatient(
        c,
        ctx,
        {
          givenName: "Sipho",
          familyName: "Dlamini",
          dateOfBirth: "1990-05-05",
          sourceChannel: "PHONE",
          contacts: [{ kind: "MOBILE", value: "083 555 0202" }],
        },
        hasher,
      ),
    );
    expect(a.possible_duplicates).toEqual([]);
    const b = await run(ctx, (c) =>
      createPatient(
        c,
        ctx,
        {
          givenName: "sipho",
          familyName: "DLAMINI",
          dateOfBirth: "1990-05-05",
          sourceChannel: "WHATSAPP",
          contacts: [{ kind: "MOBILE", value: "+27835550202" }],
        },
        hasher,
      ),
    );
    expect(b.possible_duplicates).toEqual([
      {
        patient_id: a.patient.id,
        reasons: ["MOBILE", "NAME_AND_DATE_OF_BIRTH"],
      },
    ]);
    // Both records remain; a shared phone returns both as candidates.
    const shared = await run(ctx, (c) =>
      patientsByPhone(c, ctx, "+27835550202"),
    );
    expect(shared.map((x) => x.id).sort()).toEqual(
      [a.patient.id, b.patient.id].sort(),
    );
    const open = await run(ctx, (c) =>
      listDuplicateCandidates(c, ctx, { status: "OPEN", limit: 10 }),
    );
    expect(open).toHaveLength(1);
    await run(ctx, (c) => reviewDuplicate(c, ctx, open[0]!.id, "DISMISSED"));
    expect(
      await failure(
        run(ctx, (c) => reviewDuplicate(c, ctx, open[0]!.id, "CONFIRMED")),
      ),
    ).toBe("DUPLICATE_REVIEW_NOT_FOUND");
    // Adding a matching e-mail later adds no second review for the same pair.
    await run(ctx, (c) =>
      addPatientContact(c, ctx, a.patient.id, {
        kind: "EMAIL",
        value: "sd@example.org",
      }),
    );
    await run(ctx, (c) =>
      addPatientContact(c, ctx, b.patient.id, {
        kind: "EMAIL",
        value: "sd@example.org",
      }),
    );
    const again = await run(ctx, (c) =>
      listDuplicateCandidates(c, ctx, { status: "OPEN", limit: 10 }),
    );
    expect(again).toHaveLength(0);
  });

  it("versions demographic updates", async () => {
    const ctx = staffCtx(p);
    const created = await run(ctx, (c) =>
      createPatient(
        c,
        ctx,
        { givenName: "Lerato", familyName: "Molefe", sourceChannel: "PHONE" },
        hasher,
      ),
    );
    await run(ctx, (c) =>
      updatePatient(c, ctx, created.patient.id, { preferredName: "Rato" }, 0),
    );
    expect(
      await failure(
        run(ctx, (c) =>
          updatePatient(c, ctx, created.patient.id, { preferredName: "L" }, 0),
        ),
      ),
    ).toBe("VERSION_CONFLICT");
    const detail = await run(ctx, (c) =>
      getPatientDetail(c, ctx, created.patient.id),
    );
    expect(detail.display_name).toBe("Rato Molefe");
  });
});
