import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  downloadLinkKey,
  signDownloadLink,
  verifyDownloadLink,
} from "../../apps/core-api/src/referral-routes.js";

describe("referral document download links", () => {
  const storageKey = Buffer.alloc(32, 1);
  const key = downloadLinkKey(storageKey);
  const now = 1_790_000_000;
  const claims = {
    t: randomUUID(),
    p: randomUUID(),
    r: randomUUID(),
    d: randomUUID(),
    u: `user:${randomUUID()}`,
    ur: "DOCTOR",
    e: now + 60,
    n: "0a1b2c3d",
  };
  it("verify only unaltered, unexpired and under the key that signed them", () => {
    const token = signDownloadLink(key, claims);
    expect(verifyDownloadLink(key, token, now)).toEqual(claims);
    expect(verifyDownloadLink(key, token, now + 60)).toBeNull();
    expect(
      verifyDownloadLink(downloadLinkKey(Buffer.alloc(32, 2)), token, now),
    ).toBeNull();
    const [version, , signature] = token.split(".");
    const otherDocument = Buffer.from(
      JSON.stringify({ ...claims, d: randomUUID() }),
    ).toString("base64url");
    expect(
      verifyDownloadLink(key, `${version}.${otherDocument}.${signature}`, now),
    ).toBeNull();
    for (const bad of ["", "v1.x.y", `${token}x`, token.replace("v1.", "v2.")])
      expect(verifyDownloadLink(key, bad, now), bad).toBeNull();
  });
  it("are signed with a key derived from, never equal to, the storage key", () => {
    expect(key).toHaveLength(32);
    expect(key.equals(storageKey)).toBe(false);
    expect(downloadLinkKey(storageKey).equals(key)).toBe(true);
  });
});
