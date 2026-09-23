import { SafeError } from "./safe-error";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";

export function permittedServiceAddress(address: string) {
  let ip = address.toLowerCase();
  // Canonicalize IPv6 before applying prefix rules: expanded loopback and
  // IPv4-mapped spellings must not bypass the same checks as compact forms.
  if (isIP(ip) === 6) {
    try {
      ip = new URL(`http://[${ip}]`).hostname.slice(1, -1);
    } catch {
      return false;
    }
  }
  if (isIP(ip) === 4) {
    const parts = ip.split(".").map(Number);
    return (
      parts[0] !== 0 &&
      parts[0] !== 127 &&
      parts[0] < 224 &&
      !(parts[0] === 169 && parts[1] === 254) &&
      ip !== "100.100.100.200"
    );
  }
  if (isIP(ip) === 6) {
    return (
      /^(?:[23]|f[cd])/.test(ip) &&
      !ip.startsWith("2002:") &&
      !ip.startsWith("2001::") &&
      !ip.startsWith("2001:0:") &&
      !ip.includes(".") &&
      !ip.startsWith("::") &&
      !/^fe[89ab]/.test(ip) &&
      !ip.startsWith("ff")
    );
  }
  return false;
}

export function serviceUrl(input: string) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SafeError("arr.url", "Invalid URL. Enter an HTTP(S) server URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new SafeError(
      "arr.url",
      "Use an HTTP(S) base URL without credentials, query, or fragment",
    );
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    (isIP(host) && !permittedServiceAddress(host))
  )
    throw new SafeError(
      "arr.address",
      "Service URL points to a prohibited address. localhost is this container; use the server LAN address or a shared-network container name.",
    );
  return url;
}

export type ArrTransport = (
  url: URL,
  key: string,
  method: string,
  body?: unknown,
) => Promise<unknown>;

/** DNS answers are validated once and the selected address is pinned to the
 * socket lookup, closing the validation-to-connection rebinding window. */
export const arrTransport: ArrTransport = async (url, key, method, body) => {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([
    lookup(host, { all: true }),
    new Promise<never>((_, reject) => {
      dnsTimer = setTimeout(
        () =>
          reject(
            new SafeError(
              "arr.timeout",
              "DNS lookup timed out; check Docker DNS/network access.",
            ),
          ),
        8000,
      );
    }),
  ])
    .catch((error) => {
      throw networkError(error);
    })
    .finally(() => clearTimeout(dnsTimer));
  if (
    !addresses.length ||
    addresses.some((a) => !permittedServiceAddress(a.address))
  )
    throw new SafeError(
      "arr.address",
      "Service DNS resolves to a prohibited address",
    );
  const address = addresses[0];
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = transport.request(
      url,
      {
        method,
        headers: {
          "X-Api-Key": key,
          Accept: "application/json",
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
        },
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 4_000_000)
            request.destroy(
              new SafeError(
                "arr.response",
                "Arr response exceeds the supported size limit",
              ),
            );
          else chunks.push(chunk);
        });
        response.on("end", () => {
          const status = response.statusCode || 500;
          if (status < 200 || status >= 300) {
            reject(
              new SafeError(
                "arr.http",
                `Arr returned HTTP ${status}. ${status === 401 ? "API key rejected; check the key." : status === 403 ? "Access forbidden; check the API key and proxy permissions." : status === 404 ? "API endpoint not found; check the URL base/path and API v3 support." : status >= 300 && status < 400 ? "Redirect rejected; enter the final server URL including its URL base." : "Check service/proxy availability."}`,
              ),
            );
            return;
          }
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve(text ? JSON.parse(text) : undefined);
          } catch {
            reject(
              new SafeError(
                "arr.response",
                "Unexpected Arr response (not JSON); check the URL base/path and proxy.",
              ),
            );
          }
        });
        response.on("error", () =>
          reject(
            new SafeError(
              "arr.response",
              "Arr response interrupted; check connectivity",
            ),
          ),
        );
      },
    );
    const timer = setTimeout(
      () =>
        request.destroy(
          new SafeError(
            "arr.timeout",
            "Arr request timed out; check connectivity and service availability.",
          ),
        ),
      8000,
    );
    request.on("close", () => clearTimeout(timer));
    request.on("error", (error) => reject(networkError(error)));
    request.end(payload);
  });
};

/** Do not serialize upstream messages: they can contain URLs, headers or keys. */
export function networkError(error: unknown): SafeError {
  if (error instanceof SafeError) return error;
  const code = (error as NodeJS.ErrnoException)?.code || "";
  if (["ENOTFOUND", "EAI_AGAIN"].includes(code))
    return new SafeError(
      "arr.dns",
      "DNS lookup failed; check the hostname and shared Docker network.",
    );
  if (code === "ECONNREFUSED")
    return new SafeError(
      "arr.refused",
      "Connection refused; check the host port and whether the service is running.",
    );
  if (["ENETUNREACH", "EHOSTUNREACH"].includes(code))
    return new SafeError(
      "arr.unreachable",
      "Host unreachable; check routing, firewall and Docker network.",
    );
  if (["ETIMEDOUT", "ESOCKETTIMEDOUT"].includes(code))
    return new SafeError(
      "arr.timeout",
      "Arr request timed out; check connectivity.",
    );
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code))
    return new SafeError(
      "arr.tls",
      "TLS certificate validation failed; use a valid trusted certificate and matching hostname.",
    );
  return new SafeError(
    "arr.network",
    "Arr connection failed; check connectivity and server availability.",
  );
}
