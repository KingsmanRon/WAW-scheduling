import { API_URL } from "./session";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export type HeaderSource = () => Promise<Record<string, string>>;

export async function api<T>(
  headers: HeaderSource,
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(await headers()),
      ...(init.body !== undefined
        ? { "content-type": "application/json" }
        : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok)
    throw new ApiError(
      res.status,
      body?.error ?? "ERROR",
      body?.message ?? `Request failed (${res.status})`,
    );
  return body as T;
}
export const newIds = () => ({
  command_id: crypto.randomUUID(),
  correlation_id: crypto.randomUUID(),
});

export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
