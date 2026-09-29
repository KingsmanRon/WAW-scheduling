import { describe, expect, it } from "vitest";
import {
  IdentifierHasher,
  canonicalIdentifier,
  identifierHint,
  isValidSouthAfricanId,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  validateIdentifier,
} from "../../packages/patients/src/index.js";

describe("patient identifier normalisation", () => {
  it("normalises South African and international phone numbers to E.164", () => {
    for (const raw of [
      "082 555 0101",
      "+27 82 555 0101",
      "0027825550101",
      "27825550101",
      " (082) 555-0101 ",
    ])
      expect(normalizePhone(raw)).toEqual({
        e164: "+27825550101",
        kind: "MOBILE",
      });
    expect(normalizePhone("011 555 0101")).toEqual({
      e164: "+27115550101",
      kind: "LANDLINE",
    });
    expect(normalizePhone("+44 20 7946 0958")?.e164).toBe("+442079460958");
    expect(normalizePhone("12345")).toBeNull();
    expect(normalizePhone("call me")).toBeNull();
  });

  it("normalises e-mail addresses and names without guessing", () => {
    expect(normalizeEmail("  Jane.Doe@Example.COM ")).toBe(
      "jane.doe@example.com",
    );
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizeName("  Thandi   Mbeki ")).toBe("Thandi Mbeki");
    expect(normalizeName("Zoé")).toBe("Zoé");
  });

  it("validates South African ID numbers (date and Luhn check digit)", () => {
    expect(isValidSouthAfricanId("8001015009087")).toBe(true);
    expect(isValidSouthAfricanId("8001015009088")).toBe(false);
    expect(isValidSouthAfricanId("8013015009087")).toBe(false);
    expect(canonicalIdentifier(" 800101 5009 087 ")).toBe("8001015009087");
    expect(validateIdentifier("NATIONAL_ID", "ZA", "800101-5009-087")).toBe(
      "8001015009087",
    );
    expect(() => validateIdentifier("NATIONAL_ID", "ZA", "123")).toThrow();
    expect(validateIdentifier("PASSPORT", "GB", "ab 123 456")).toBe("AB123456");
  });

  it("stores only keyed digests and short hints of identity numbers", () => {
    const a = new IdentifierHasher(Buffer.alloc(32, 1), "k1");
    const b = new IdentifierHasher(Buffer.alloc(32, 2), "k2");
    const digest = a.digest("NATIONAL_ID", "ZA", "8001015009087");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain("8001015009087");
    // Deterministic for search, different per key, bound to system and issuer.
    expect(a.digest("NATIONAL_ID", "za", "8001015009087")).toBe(digest);
    expect(b.digest("NATIONAL_ID", "ZA", "8001015009087")).not.toBe(digest);
    expect(a.digest("PASSPORT", "ZA", "8001015009087")).not.toBe(digest);
    expect(identifierHint("NATIONAL_ID", "8001015009087")).toBe("9087");
    expect(() => new IdentifierHasher(Buffer.alloc(8), "short")).toThrow();
  });
});
