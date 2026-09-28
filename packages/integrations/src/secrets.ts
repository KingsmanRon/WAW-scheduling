import { DeliveryFailure } from "./errors.js";

/**
 * Connections name the environment variable (secret manager entry) that
 * holds their credential; the value never touches the database. A name is
 * only honoured under its provider's prefix, so a connection can never be
 * pointed at an unrelated platform secret such as DATABASE_URL.
 */
export const SECRET_PREFIXES = {
  WHATSAPP_CLOUD: "WHATSAPP_",
  EMR_WEBHOOK: "EMR_WEBHOOK_",
} as const;
export type SecretProvider = keyof typeof SECRET_PREFIXES;
/** Platform-level secrets that connections may never reference. */
const RESERVED = new Set(["WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN"]);
const MIN_LENGTH: Record<SecretProvider, number> = {
  WHATSAPP_CLOUD: 20,
  EMR_WEBHOOK: 32,
};

export function secretRefAllowed(
  provider: SecretProvider,
  ref: string,
): boolean {
  return (
    /^[A-Z][A-Z0-9_]{2,100}$/.test(ref) &&
    ref.startsWith(SECRET_PREFIXES[provider]) &&
    !RESERVED.has(ref)
  );
}

export function resolveSecret(
  provider: SecretProvider,
  ref: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!ref || !secretRefAllowed(provider, ref))
    throw new DeliveryFailure("CONFIGURATION", "SECRET_REF_INVALID");
  const value = env[ref];
  if (!value || value.length < MIN_LENGTH[provider])
    throw new DeliveryFailure("CONFIGURATION", "SECRET_UNAVAILABLE");
  return value;
}
