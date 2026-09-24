import http from "node:http";
import { networkInterfaces } from "node:os";
import { once } from "node:events";
import { afterAll, beforeAll, expect, it } from "vitest";
import { RadarrClient, SonarrClient } from "../src/lib/clients";
import { enumerateRadarr, enumerateSonarr } from "../src/lib/library";
import { arrTransport } from "../src/lib/arr-transport";
import { ArrArrayReader, ARRAY_LIMITS } from "../src/lib/arr-array";
const count = 600;
const padding = "bounded unused plot ".repeat(500);
const key = "isolated-library-key";
const requests: string[] = [];
let base: string;
let bytes = 0;
const server = http.createServer(async (req, res) => {
  requests.push(req.url!);
  if (req.headers["x-api-key"] !== key) {
    res.writeHead(401);
    res.end("do not expose upstream secret");
    return;
  }
  const u = new URL(req.url!, "http://fixture");
  if (!u.pathname.startsWith("/base/api/v3/")) {
    res.writeHead(404);
    res.end();
    return;
  }
  const endpoint = u.pathname.slice("/base/api/v3/".length);
  if (endpoint === "stall") {
    res.writeHead(200);
    res.write("[");
    return;
  }
  let records: Iterable<unknown>;
  if (endpoint === "movie")
    records = (function* () {
      for (let id = 1; id <= count; id++)
        yield {
          id,
          title: `Movie ${id}`,
          hasFile: true,
          overview: padding,
          movieFile: {
            id: id + 10000,
            movieId: id,
            path: `/movies/${id}.mkv`,
            languages: [{ id: 1, name: "English" }],
          },
        };
    })();
  else if (endpoint === "series")
    records = (function* () {
      for (let id = 1; id <= count; id++)
        yield { id, title: `Series ${id}`, overview: padding };
    })();
  else if (endpoint === "episode") {
    const id = Number(u.searchParams.get("seriesId"));
    records = [
      {
        id,
        seriesId: id,
        episodeFileId: id + 10000,
        seasonNumber: 1,
        episodeNumber: 1,
        title: "Episode",
      },
    ];
  } else if (endpoint === "episodefile") {
    const id = Number(u.searchParams.get("seriesId"));
    records = [
      {
        id: id + 10000,
        seriesId: id,
        path: `/tv/${id}.mkv`,
        languages: [{ id: 1, name: "English" }],
      },
    ];
  } else {
    res.writeHead(404);
    res.end();
    return;
  }
  res.setHeader("Content-Type", "application/json");
  res.write("[");
  let first = true;
  for (const record of records) {
    if (res.destroyed) return;
    const chunk = (first ? "" : ",") + JSON.stringify(record);
    first = false;
    bytes += Buffer.byteLength(chunk);
    if (!res.write(chunk)) {
      // Destroyed clients must not leave fixture writers/listeners pending.
      const continued = await new Promise<boolean>((resolve) => {
        const close = () => {
          res.off("drain", drain);
          resolve(false);
        };
        const drain = () => {
          res.off("close", close);
          resolve(true);
        };
        res.once("drain", drain);
        res.once("close", close);
      });
      if (!continued) return;
    }
  }
  res.end("]");
});
beforeAll(async () => {
  const address = Object.values(networkInterfaces())
    .flat()
    .find((i) => i?.family === "IPv4" && !i.internal)?.address;
  if (!address)
    throw new Error("Isolated non-loopback fixture interface required");
  server.listen(0, "0.0.0.0");
  await once(server, "listening");
  base = `http://${address}:${(server.address() as { port: number }).port}/base`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
it.each(["radarr", "sonarr"] as const)(
  "enumerates a real >4 MB %s HTTP response, preserving exact first/last files without duplicates",
  async (source) => {
    bytes = 0;
    requests.length = 0;
    const files =
      source === "radarr"
        ? await enumerateRadarr(new RadarrClient(base, key))
        : await enumerateSonarr(new SonarrClient(base, key));
    expect(bytes).toBeGreaterThan(4_000_000);
    expect(files).toHaveLength(count);
    expect(new Set(files.map((f) => f.fileId)).size).toBe(count);
    expect(files[0]).toMatchObject({
      entityId: 1,
      fileId: 10001,
      languageEvidence: { source, languages: ["English"] },
    });
    expect(files.at(-1)).toMatchObject({
      entityId: count,
      fileId: count + 10000,
    });
    expect(JSON.stringify(files).length).toBeLessThan(400_000);
    expect(requests.every((u) => u.startsWith("/base/api/v3/"))).toBe(true);
    if (source === "radarr") expect(requests).toEqual(["/base/api/v3/movie"]); // no per-file language requests
  },
  20000,
);
it("proves the unchanged ordinary transport rejects this same oversized response", async () => {
  await expect(
    arrTransport(new URL(`${base}/api/v3/movie`), key, "GET"),
  ).rejects.toThrow("size limit");
});
it("still requires authentication and preserves useful URL-base errors", async () => {
  await expect(new RadarrClient(base, "wrong-key").movies()).rejects.toThrow(
    "HTTP 401",
  );
  await expect(new SonarrClient(base + "/wrong", key).series()).rejects.toThrow(
    "HTTP 404",
  );
});
it("cancels an in-flight streamed response promptly", async () => {
  const controller = new AbortController();
  const promise = arrTransport(
    new URL(`${base}/api/v3/stall`),
    key,
    "GET",
    undefined,
    { signal: controller.signal, project: (v) => v },
  );
  setTimeout(() => controller.abort(), 30);
  await expect(promise).rejects.toThrow();
});
it("retains a bounded idle timeout for a stalled library response", async () => {
  await expect(
    arrTransport(new URL(`${base}/api/v3/stall`), key, "GET", undefined, {
      project: (v) => v,
    }),
  ).rejects.toThrow("stalled");
}, 12000);
it.each([
  '[{"id":1},]',
  '[{"id":1}',
  "{}",
  "[true]",
  '[{"id":1}]junk',
  '[{"id":1],"extra":2}]',
])("rejects malformed/truncated array %s", (input) => {
  const reader = new ArrArrayReader((v) => v);
  expect(() => {
    reader.write(Buffer.from(input));
    reader.finish();
  }).toThrow();
});
it("handles escaped delimiters, nested data and split UTF8 without buffering the full payload", () => {
  const record = { id: 1, title: 'é { ] \\"', nested: [{ value: 2 }] };
  const reader = new ArrArrayReader((v) => (v as { title: string }).title);
  for (const byte of Buffer.from(JSON.stringify([record])))
    reader.write(Buffer.from([byte]));
  expect(reader.finish()).toEqual([record.title]);
});
it("bounds individual records and total wire bytes independently", () => {
  const record = new ArrArrayReader((v) => v);
  expect(() =>
    record.write(
      Buffer.from('[{"plot":"' + "a".repeat(ARRAY_LIMITS.recordChars)),
    ),
  ).toThrow("bounded");
  const wire = new ArrArrayReader((v) => v);
  const chunk = Buffer.alloc(1_000_000, 32);
  expect(() => {
    for (let i = 0; i < 65; i++) wire.write(chunk);
  }).toThrow("bounded");
});
it("enforces record count, retained metadata and nesting bounds", () => {
  const countReader = new ArrArrayReader((v) => v);
  expect(() =>
    countReader.write(
      Buffer.from("[" + Array(100001).fill("{}").join(",") + "]"),
    ),
  ).toThrow("bounded");
  const depthReader = new ArrArrayReader((v) => v);
  expect(() =>
    depthReader.write(Buffer.from('[{"nested":' + "[".repeat(65))),
  ).toThrow("bounded");
  const retained = new ArrArrayReader(() => ({ title: "x".repeat(100_000) }));
  expect(() =>
    retained.write(Buffer.from("[" + Array(161).fill("{}").join(",") + "]")),
  ).toThrow("bounded");
});
