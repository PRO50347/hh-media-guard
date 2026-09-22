export function allowedOrigins() {
  const values = [
    process.env.APP_URL || "http://localhost:3938",
    ...(process.env.ALLOWED_ORIGINS || "").split(",").filter(Boolean),
  ];
  return values.map((value) => {
    const url = new URL(value.trim());
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      value.includes("*")
    )
      throw new Error(
        "APP_URL and ALLOWED_ORIGINS must contain exact HTTP(S) origins",
      );
    return url.origin;
  });
}
export function validateOrigin(origin: string | null) {
  if (!origin || !allowedOrigins().includes(origin))
    throw new Error("Untrusted request origin");
}
export function validateCsrf(actual: string | null, expected: string) {
  if (!actual || actual !== expected) throw new Error("Invalid CSRF token");
}
