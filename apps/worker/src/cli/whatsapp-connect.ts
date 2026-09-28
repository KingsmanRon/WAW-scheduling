import { parseArgs } from "node:util";
import pg from "pg";
import { provisionWhatsApp } from "@access/access";

/**
 * Operator command: route a WhatsApp Business phone number (Meta
 * phone_number_id) to a practice.
 *
 *   MIGRATION_DATABASE_URL=... npm run channel:whatsapp:connect -- \
 *     --tenant <org uuid> --practice <practice uuid> \
 *     --phone-number-id 1234567890 --display-number +27110000000 \
 *     --secret-ref WHATSAPP_ACCESS_TOKEN [--waba-id 987654321] \
 *     [--language en] [--name "Practice WhatsApp"] [--disable]
 *
 * The access token itself is set as <secret-ref> in the worker's
 * environment; it is never passed here or stored in the database.
 */
const { values } = parseArgs({
  options: {
    tenant: { type: "string" },
    practice: { type: "string" },
    "phone-number-id": { type: "string" },
    "display-number": { type: "string" },
    "waba-id": { type: "string" },
    "secret-ref": { type: "string" },
    language: { type: "string" },
    name: { type: "string" },
    operator: { type: "string" },
    disable: { type: "boolean" },
  },
});
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  process.stderr.write(
    "MIGRATION_DATABASE_URL is required (operator credential)\n",
  );
  process.exit(64);
}
for (const required of [
  "tenant",
  "practice",
  "phone-number-id",
  "secret-ref",
] as const)
  if (!values[required]) {
    process.stderr.write(`--${required} is required\n`);
    process.exit(64);
  }
const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  const result = await provisionWhatsApp(pool, {
    tenantId: values.tenant!,
    practiceId: values.practice!,
    name: values.name ?? "Practice WhatsApp",
    secretRef: values["secret-ref"]!,
    active: !values.disable,
    operator: `operator:${values.operator ?? process.env.USER ?? "cli"}`,
    config: {
      phone_number_id: values["phone-number-id"]!,
      ...(values["waba-id"] ? { waba_id: values["waba-id"] } : {}),
      ...(values["display-number"]
        ? { display_phone_number: values["display-number"] }
        : {}),
      default_language: values.language ?? "en",
      templates: {},
    },
  });
  process.stdout.write(
    `${values.disable ? "Disabled" : "Connected"} WhatsApp number ${result.routeKey} (connection ${result.connectionId}).\n`,
  );
} catch (e) {
  process.stderr.write(
    `${e instanceof Error ? e.message : "provisioning failed"}\n`,
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
