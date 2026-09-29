/**
 * Settings shared by the browser suite's servers (API, worker, console, the
 * Graph API stand-in) and its tests. Everything here is synthetic and local.
 */
export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/access_e2e";

const host = "127.0.0.1";
export const PORTS = { api: 3101, worker: 3102, graph: 3109, console: 4173 };
export const API_URL = `http://${host}:${PORTS.api}`;
export const CONSOLE_URL = `http://${host}:${PORTS.console}`;
export const GRAPH_URL = `http://${host}:${PORTS.graph}`;

/** The runtime logins (cluster-wide roles; same passwords as the vitest setup). */
export const API_LOGIN = "access_request:integration-api";
export const WORKER_LOGIN = "access_worker:integration-worker";
export function loginUrl(login: string): string {
  const url = new URL(E2E_DATABASE_URL);
  const [user, password] = login.split(":") as [string, string];
  url.username = user;
  url.password = password;
  return url.toString();
}

/** Fixed identifiers so specs can address the seeded practice directly. */
export const TENANT_ID = "e2e00000-0000-4000-8000-000000000001";
export const PRACTICE_ID = "e2e00000-0000-4000-8000-000000000002";
export const PRACTICE_NAME = "E2E Family Practice";

/** Meta app settings of the API, and the practice number's access token. */
export const WHATSAPP = {
  appSecret: "e2e-meta-app-secret-0123456789abcdef",
  verifyToken: "e2e-verify-token-0123456789",
  tokenRef: "WHATSAPP_E2E_TOKEN",
  token: "e2e-whatsapp-access-token-0123456789abcdef",
  phoneNumberId: "2710000000001",
};
export const IDENTIFIER_HASH_KEY = "07".repeat(32);

/**
 * Seeded patients, one set per spec so specs never compete for a patient's
 * time. Their numbers are on the worker's synthetic recipient allow-list,
 * so business-initiated WhatsApp messages to them are sent. All but Sipho
 * have agreed to WhatsApp messages.
 */
export const PATIENTS = {
  naledi: {
    given: "Naledi",
    family: "Dube",
    mobile: "+27821110001",
    dob: "1986-02-14",
  },
  lerato: {
    given: "Lerato",
    family: "Mahlangu",
    mobile: "+27821110002",
    dob: "1991-05-02",
  },
  pieter: {
    given: "Pieter",
    family: "Venter",
    mobile: "+27821110003",
    dob: "1979-07-30",
  },
  johan: {
    given: "Johan",
    family: "Pretorius",
    mobile: "+27821110004",
    dob: "1968-12-11",
  },
  fatima: {
    given: "Fatima",
    family: "Adams",
    mobile: "+27821110005",
    dob: "1983-03-23",
  },
  themba: {
    given: "Themba",
    family: "Ngcobo",
    mobile: "+27821110006",
    dob: "1990-10-08",
  },
  aisha: {
    given: "Aisha",
    family: "Khan",
    mobile: "+27821110007",
    dob: "1995-11-05",
  },
  zanele: {
    given: "Zanele",
    family: "Mokoena",
    mobile: "+27821110008",
    dob: "1988-06-19",
  },
  sipho: {
    given: "Sipho",
    family: "Mthembu",
    mobile: "+27821110009",
    dob: "2001-09-17",
  },
} as const;
export type PatientKey = keyof typeof PATIENTS;
export const ALLOW_LIST = Object.values(PATIENTS)
  .map((p) => p.mobile)
  .join(",");
