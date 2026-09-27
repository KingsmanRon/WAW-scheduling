import pg from "pg";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT } from "jose";
import type { FastifyInstance } from "fastify";
import { seedTenant } from "../../packages/db/src/index.js";
import {
  DEFAULT_RULE_DEFINITION,
  type RuleDefinitionInput,
} from "../../packages/rules/src/index.js";
import { buildApp } from "../../apps/core-api/src/app.js";
import {
  JwtAuthenticator,
  SyntheticAuthenticator,
  type Authenticator,
} from "../../apps/core-api/src/auth.js";
import {
  IntakeExtractor,
  type ExtractionPort,
} from "../../apps/core-api/src/extraction.js";
import {
  MockSyntheticScanner,
  type ArtifactScanner,
} from "../../apps/core-api/src/scanner.js";
import { CaseService } from "../../apps/core-api/src/service.js";
import {
  LocalEncryptedArtifactStore,
  type ArtifactStore,
} from "../../apps/core-api/src/storage.js";
import {
  CapabilityGate,
  MockConnector,
  type Connector,
  type MockOptions,
} from "../../apps/worker/src/connector.js";
import {
  Dispatcher,
  type DispatcherOptions,
} from "../../apps/worker/src/dispatcher.js";

export const databaseEnabled = Boolean(process.env.TEST_DATABASE_URL);
export const JWT_SECRET = "integration-test-secret-at-least-32-characters";
export const JWT_ISSUER = "https://auth.test.invalid/auth/v1";
export const JWT_AUDIENCE = "authenticated";

let owner: pg.Pool | undefined;
let api: pg.Pool | undefined;
let worker: pg.Pool | undefined;
function roleUrl(role: string, password: string) {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.username = role;
  url.password = password;
  return url.toString();
}
/** Migration owner (superuser in tests): setup and assertions only. */
export function ownerPool(): pg.Pool {
  return (owner ??= new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    max: 4,
  }));
}
/** The least-privilege API login used by every API code path under test. */
export function apiPool(): pg.Pool {
  return (api ??= new pg.Pool({
    connectionString: roleUrl("access_request", "integration-api"),
    max: 8,
  }));
}
/** The least-privilege worker login used by every dispatcher under test. */
export function workerPool(): pg.Pool {
  return (worker ??= new pg.Pool({
    connectionString: roleUrl("access_worker", "integration-worker"),
    max: 8,
  }));
}
export async function closePools() {
  await Promise.all([owner?.end(), api?.end(), worker?.end()]);
  owner = api = worker = undefined;
}

export async function newTenant(
  options: {
    destinationMode?: "CONNECTOR" | "MANUAL";
    definition?: RuleDefinitionInput;
  } = {},
): Promise<string> {
  const id = randomUUID();
  await seedTenant(ownerPool(), {
    id,
    name: `Test organisation ${id.slice(0, 8)}`,
    destinationMode: options.destinationMode ?? "CONNECTOR",
    ...(options.definition ? { definition: options.definition } : {}),
  });
  return id;
}
export function ruleDefinition(
  overrides: Partial<RuleDefinitionInput>,
): RuleDefinitionInput {
  return { ...DEFAULT_RULE_DEFINITION, ...overrides };
}

export interface TestApi {
  app: FastifyInstance;
  service: CaseService;
  artifactRoot: string;
  store: ArtifactStore;
  close(): Promise<void>;
}
export async function testApi(
  options: {
    auth?: "synthetic" | "jwt";
    scanner?: ArtifactScanner;
    extractor?: ExtractionPort;
    store?: ArtifactStore;
  } = {},
): Promise<TestApi> {
  const artifactRoot = await mkdtemp(join(tmpdir(), "access-artifacts-"));
  const store =
    options.store ??
    new LocalEncryptedArtifactStore(artifactRoot, Buffer.alloc(32, 9));
  const service = new CaseService({
    pool: apiPool(),
    artifacts: store,
    scanner: options.scanner ?? new MockSyntheticScanner(),
    extractor:
      options.extractor ?? new IntakeExtractor({ fixturesAllowed: true }),
    retentionDays: 30,
  });
  const authenticator: Authenticator =
    options.auth === "jwt"
      ? new JwtAuthenticator(
          {
            mode: "jwt",
            issuer: JWT_ISSUER,
            audience: JWT_AUDIENCE,
            hsSecret: JWT_SECRET,
          },
          apiPool(),
        )
      : new SyntheticAuthenticator();
  const app = await buildApp({
    pool: apiPool(),
    service,
    authenticator,
    corsOrigins: ["http://localhost:3000"],
    info: { profile: "local", dataMode: "SYNTHETIC", buildId: "test" },
  });
  return { app, service, artifactRoot, store, close: () => app.close() };
}

export async function mintToken(
  sub: string,
  overrides: {
    secret?: string;
    issuer?: string;
    audience?: string;
    expiresIn?: string;
  } = {},
): Promise<string> {
  return new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuer(overrides.issuer ?? JWT_ISSUER)
    .setAudience(overrides.audience ?? JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(overrides.expiresIn ?? "5m")
    .sign(new TextEncoder().encode(overrides.secret ?? JWT_SECRET));
}
export async function grantMembership(
  tenantId: string,
  userId: string,
  role: string,
  status = "ACTIVE",
) {
  await ownerPool().query(
    `INSERT INTO organisation_memberships(tenant_id,user_id,role,status,created_by,updated_by) VALUES($1,$2,$3,$4,'test','test')
     ON CONFLICT (tenant_id,user_id) DO UPDATE SET role=excluded.role,status=excluded.status`,
    [tenantId, userId, role, status],
  );
}

export const b64 = (text: string) => Buffer.from(text).toString("base64");
export function staff(
  tenantId: string,
  role = "REFERRAL_COORDINATOR",
  user = "coordinator",
) {
  return {
    "x-tenant-id": tenantId,
    "x-access-role": role,
    "x-access-user": user,
  };
}
export function ingestBody(overrides: Record<string, unknown> = {}) {
  return {
    command_id: randomUUID(),
    referral_id: randomUUID(),
    correlation_id: randomUUID(),
    expected_version: 0,
    filename: "synthetic.txt",
    media_type: "text/plain",
    content_base64: b64(`synthetic referral ${randomUUID()}`),
    fixture: "complete",
    ...overrides,
  };
}
export function actionBody(
  action: string,
  expectedVersion: number,
  extra: Record<string, unknown> = {},
) {
  return {
    action,
    command_id: randomUUID(),
    correlation_id: randomUUID(),
    expected_version: expectedVersion,
    note: `synthetic ${action} note`,
    ...extra,
  };
}

export async function ingest(
  t: TestApi,
  tenantId: string,
  overrides: Record<string, unknown> = {},
  role?: string,
) {
  const res = await t.app.inject({
    method: "POST",
    url: "/v1/referrals",
    headers: staff(tenantId, role),
    payload: ingestBody(overrides),
  });
  if (res.statusCode >= 300)
    throw new Error(`ingest failed ${res.statusCode}: ${res.body}`);
  return res.json() as {
    case_id: string;
    referral_id: string;
    state: string;
    version: number;
    execution_id: string | null;
    deduplicated: boolean;
  };
}
export async function act(
  t: TestApi,
  tenantId: string,
  caseId: string,
  body: Record<string, unknown>,
  role?: string,
) {
  return t.app.inject({
    method: "POST",
    url: `/v1/cases/${caseId}/actions`,
    headers: staff(tenantId, role),
    payload: body,
  });
}
export async function detail(
  t: TestApi,
  tenantId: string,
  caseId: string,
  role?: string,
) {
  const res = await t.app.inject({
    method: "GET",
    url: `/v1/cases/${caseId}`,
    headers: staff(tenantId, role),
  });
  if (res.statusCode !== 200)
    throw new Error(`detail failed ${res.statusCode}: ${res.body}`);
  return res.json();
}
export async function caseState(caseId: string): Promise<{
  current_state: string;
  version: number;
  resolution_code: string | null;
}> {
  const row = await ownerPool().query(
    "SELECT current_state,version,resolution_code FROM access_cases WHERE id=$1",
    [caseId],
  );
  return row.rows[0];
}

export function dispatcher(
  tenantIds: string[],
  connector: Connector = new MockConnector(),
  options: Partial<DispatcherOptions> & { capabilities?: string[] } = {},
) {
  const gate = new CapabilityGate(
    connector,
    (options.capabilities ?? [
      "patient.lookup",
      "referral.create",
      "referral.status.read",
      "appointment.status.read",
    ]) as never,
  );
  return new Dispatcher(workerPool(), connector, gate, {
    maxDispatch: 3,
    retrySeconds: 0,
    maxReconcile: 3,
    reconcileBaseSeconds: 0,
    tenantIds,
    ...options,
  });
}
export function mock(options: MockOptions = {}) {
  return new MockConnector(options);
}
/** Drain dispatch and reconciliation until nothing is due (bounded). */
export async function drain(d: Dispatcher, rounds = 20) {
  for (let i = 0; i < rounds; i++) {
    const worked = await d.tick();
    const reconciled = await d.reconcile();
    if (!worked && !reconciled) return;
  }
}
export async function countFiles(root: string): Promise<number> {
  let n = 0;
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(
      () => [],
    ))
      if (entry.isDirectory()) await walk(join(dir, entry.name));
      else n++;
  };
  await walk(root);
  return n;
}
export async function tableCounts(tenantId: string) {
  const tables = [
    "access_cases",
    "referrals",
    "artifacts",
    "commands",
    "evidence_events",
    "work_items",
    "executions",
    "outbox",
    "access_interactions",
    "access_case_observations",
    "case_effort_events",
    "access_case_transitions",
  ];
  const out: Record<string, number> = {};
  for (const t of tables)
    out[t] = (
      await ownerPool().query(
        `SELECT count(*)::int n FROM ${t} WHERE tenant_id=$1`,
        [tenantId],
      )
    ).rows[0].n;
  return out;
}
