import { createHmac } from "node:crypto";
import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import type { CountryCode } from "libphonenumber-js";
import { SchedulingError } from "@access/scheduling";

/**
 * Normalisation of the identifiers used to find a patient. Search and
 * duplicate detection compare normalised values only (E.164 phone numbers,
 * lower-case e-mail, canonical identifier strings); names are never used to
 * merge records.
 */

export interface NormalizedPhone {
  e164: string;
  kind: "MOBILE" | "LANDLINE";
}
/** Parse a phone number (national or international form) to E.164. */
export function normalizePhone(
  raw: string,
  defaultCountry: CountryCode = "ZA",
): NormalizedPhone | null {
  const trimmed = raw.trim();
  if (!/^[+0-9()\s.-]{5,25}$/.test(trimmed)) return null;
  const parsed = parsePhoneNumberFromString(trimmed, defaultCountry);
  if (!parsed || !parsed.isValid()) return null;
  const type = parsed.getType();
  return {
    e164: parsed.number,
    kind:
      type === "FIXED_LINE" || type === "TOLL_FREE" || type === "SHARED_COST"
        ? "LANDLINE"
        : "MOBILE",
  };
}
export function requirePhone(
  raw: string,
  defaultCountry: CountryCode = "ZA",
): NormalizedPhone {
  const phone = normalizePhone(raw, defaultCountry);
  if (!phone) throw new SchedulingError("CONTACT_INVALID");
  return phone;
}

const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s]{2,63}$/;
export function normalizeEmail(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  return EMAIL.test(value) && value.length <= 254 ? value : null;
}

/** Trim, collapse inner whitespace, NFC-normalise. */
export function normalizeName(raw: string): string {
  return raw.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** Canonical identifier value: upper case, no spaces, dashes or slashes. */
export function canonicalIdentifier(value: string): string {
  return value
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[\s/-]/g, "");
}

/** South African ID number: 13 digits, valid date of birth, Luhn check digit. */
export function isValidSouthAfricanId(value: string): boolean {
  if (!/^\d{13}$/.test(value)) return false;
  const month = Number(value.slice(2, 4));
  const day = Number(value.slice(4, 6));
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    let digit = Number(value[12 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

export type IdentifierSystem = "NATIONAL_ID" | "PASSPORT" | "EXTERNAL";
export function validateIdentifier(
  system: IdentifierSystem,
  issuer: string,
  value: string,
): string {
  const canonical = canonicalIdentifier(value);
  const ok =
    system === "NATIONAL_ID"
      ? issuer === "ZA"
        ? isValidSouthAfricanId(canonical)
        : /^[A-Z0-9]{4,30}$/.test(canonical)
      : system === "PASSPORT"
        ? /^[A-Z0-9]{5,20}$/.test(canonical)
        : /^[A-Z0-9._:]{1,120}$/.test(canonical);
  if (!ok || !/^[A-Za-z0-9_.:-]{1,80}$/.test(issuer))
    throw new SchedulingError("IDENTIFIER_INVALID");
  return canonical;
}

/**
 * Keyed digest of an identifier. The key (IDENTIFIER_HASH_KEY) lives in the
 * secret store; the database holds only digests of national ID and passport
 * numbers, so a database copy alone cannot reveal or test them.
 */
export class IdentifierHasher {
  constructor(
    private readonly key: Buffer,
    readonly keyId: string,
  ) {
    if (key.length < 32)
      throw new Error("identifier hash key must be at least 32 bytes");
  }
  digest(system: IdentifierSystem, issuer: string, canonical: string): string {
    return createHmac("sha256", this.key)
      .update(`${system}|${issuer.toUpperCase()}|${canonical}`)
      .digest("hex");
  }
}

/** Last characters shown to staff to tell identifiers apart (never the whole value). */
export function identifierHint(
  system: IdentifierSystem,
  canonical: string,
): string {
  return system === "EXTERNAL" ? canonical.slice(-8) : canonical.slice(-4);
}
