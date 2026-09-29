import dns from "node:dns";
import net from "node:net";
import { DeliveryFailure } from "./errors.js";

/**
 * Outbound targets configured by practices (EMR webhooks) must be public
 * HTTPS endpoints. Addresses are checked when the socket connects (the
 * `lookup` below), not only when the URL is saved, so a DNS answer that
 * later points at an internal address is refused too.
 */
const blocked = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  blocked.addSubnet(network, prefix, "ipv6");

/** True when `address` is a globally routable unicast address. */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return isPublicAddress(mapped[1]!);
    return !blocked.check(address, "ipv6");
  }
  return false;
}

export interface TargetPolicy {
  /** Local development and tests only: http:// and private addresses. */
  allowInsecure: boolean;
}

/** Validate a configured outbound URL (shape only; addresses at connect). */
export function assertOutboundUrl(raw: string, policy: TargetPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DeliveryFailure("CONFIGURATION", "TARGET_URL_INVALID");
  }
  if (url.username || url.password)
    throw new DeliveryFailure("CONFIGURATION", "TARGET_URL_HAS_CREDENTIALS");
  if (
    url.protocol !== "https:" &&
    !(policy.allowInsecure && url.protocol === "http:")
  )
    throw new DeliveryFailure("CONFIGURATION", "TARGET_URL_NOT_HTTPS");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!policy.allowInsecure) {
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".internal") ||
      host.endsWith(".local")
    )
      throw new DeliveryFailure("CONFIGURATION", "TARGET_NOT_PUBLIC");
    if (net.isIP(host) && !isPublicAddress(host))
      throw new DeliveryFailure("CONFIGURATION", "TARGET_NOT_PUBLIC");
  }
  return url;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

/**
 * A net/http `lookup` that resolves normally and then refuses non-public
 * addresses. Handles both the single-address and the `all: true` form
 * (Node's happy-eyeballs connect asks for every address).
 */
export function publicOnlyLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: LookupCallback,
): void {
  dns.lookup(
    hostname,
    { ...options, verbatim: true },
    (err, address, family) => {
      if (err) return callback(err, "", undefined);
      const all: dns.LookupAddress[] = Array.isArray(address)
        ? address
        : [{ address: address as string, family: family ?? 4 }];
      if (!all.length || all.some((a) => !isPublicAddress(a.address))) {
        const refused = Object.assign(
          new Error("target address is not public"),
          {
            code: "EBLOCKEDADDRESS",
          },
        ) as NodeJS.ErrnoException;
        return callback(refused, "", undefined);
      }
      if (options.all) return callback(null, all);
      return callback(null, all[0]!.address, all[0]!.family);
    },
  );
}

/**
 * Resolve a configured target now and refuse it unless every address is
 * public (early feedback when the URL is saved; the connect-time lookup
 * still guards every request).
 */
export async function assertPublicTarget(
  url: URL,
  policy: TargetPolicy,
): Promise<void> {
  if (policy.allowInsecure) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: dns.LookupAddress[];
  try {
    addresses = net.isIP(host)
      ? [{ address: host, family: net.isIP(host) }]
      : await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new DeliveryFailure("CONFIGURATION", "TARGET_UNRESOLVABLE");
  }
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address)))
    throw new DeliveryFailure("CONFIGURATION", "TARGET_NOT_PUBLIC");
}
