"use client";
export async function api<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.method && options.method !== "GET") {
    const session = await fetch("/api/auth", { cache: "no-store" }).then(
      (response) => response.json(),
    );
    if (!session.authenticated)
      throw new Error("Your session expired. Sign in again.");
    headers.set("x-csrf-token", session.csrfToken);
  }
  const response = await fetch(url, { ...options, headers, cache: "no-store" });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || `Request failed (${response.status})`);
  return data as T;
}
export const json = (method: string, value: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});
