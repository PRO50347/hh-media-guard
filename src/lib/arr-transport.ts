import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";

export function permittedServiceAddress(address: string) {
  const ip = address.toLowerCase();
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
      !ip.includes(".") &&
      !ip.startsWith("::") &&
      !/^fe[89ab]/.test(ip) &&
      !ip.startsWith("ff")
    );
  }
  return false;
}

export function serviceUrl(input: string) {
  const url = new URL(input);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Use an HTTP(S) base URL without credentials, query, or fragment",
    );
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    (isIP(host) && !permittedServiceAddress(host))
  )
    throw new Error("Service URL points to a prohibited address");
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
        () => reject(new Error("Arr DNS lookup timed out")),
        8000,
      );
    }),
  ]).finally(() => clearTimeout(dnsTimer));
  if (
    !addresses.length ||
    addresses.some((a) => !permittedServiceAddress(a.address))
  )
    throw new Error("Service DNS resolves to a prohibited address");
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
          if (size > 4_000_000) request.destroy(new Error("limit"));
          else chunks.push(chunk);
        });
        response.on("end", () => {
          const status = response.statusCode || 500;
          if (status < 200 || status >= 300) {
            reject(new Error(`Arr request failed with HTTP ${status}`));
            return;
          }
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve(text ? JSON.parse(text) : undefined);
          } catch {
            reject(new Error("Arr returned malformed JSON"));
          }
        });
        response.on("error", () =>
          reject(new Error("Arr response interrupted")),
        );
      },
    );
    const timer = setTimeout(() => request.destroy(new Error("timeout")), 8000);
    request.on("close", () => clearTimeout(timer));
    request.on("error", () =>
      reject(new Error("Arr request failed or timed out; check connectivity")),
    );
    request.end(payload);
  });
};
