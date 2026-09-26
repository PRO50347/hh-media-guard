import * as historyModule from "../src/lib/remediation-history";
import { requireManualAdmission } from "../src/lib/remediation-admission";
import {
  preMutationRetryProof,
  type RetryOperation,
} from "../src/lib/remediation-retry";
import {
  beforeAll,
  afterAll,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import {
  mkdtemp,
  mkdir,
  rm,
  lstat,
  writeFile,
  readFile,
  rename,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RadarrClient, SonarrClient } from "../src/lib/clients";
import type { ArrTransport } from "../src/lib/arr-transport";
import {
  remediate,
  verifyReplacement,
  type MediaIdentity,
} from "../src/lib/remediation";
import { resolveAttention } from "../src/lib/attention";
import { reserveReplacement, resetReplacement } from "../src/lib/retries";
import {
  addMapping,
  saveSettings,
  saveScan,
  raw,
  upsertMediaItem,
  saveIntegration,
  jobQueue,
  quarantine,
} from "../src/lib/store";
import { scanFile } from "../src/lib/scanner";
import { runProcess } from "../src/lib/process";
import { encryptSecret } from "../src/lib/crypto";
import * as transportModule from "../src/lib/arr-transport";
import {
  queueManualRemediation,
  queuePreMutationRetry,
  manualRemediationControl,
  attentionRemediation,
} from "../src/lib/manual-remediation";
import { executeJob } from "../src/lib/worker";
import { cleanupVerifiedQuarantine } from "../src/lib/quarantine-cleanup";
import { RuntimeLease, attachRuntimeLease } from "../src/lib/runtime-lease";
import { POST as queueRequest } from "../src/app/api/jobs/route";
import { DELETE as cleanupRequest } from "../src/app/api/quarantine/route";
import { requireAdmin } from "../src/lib/auth";
vi.mock("../src/lib/auth", () => ({
  requireAdmin: vi.fn(async () => ({ username: "fixture-admin" })),
}));
let root: string;
let media: string;
let destination: string;
let sequence = 1000;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "media-guard-remediation-"));
  media = path.join(root, "media");
  destination = path.join(root, "quarantine");
  await mkdir(media);
  await mkdir(destination);
  for (const source of ["sonarr", "radarr"] as const)
    addMapping({
      source,
      arrPath: `/${source}`,
      containerPath: media,
      mediaType: "other",
      enabled: true,
    });
});
afterAll(() => rm(root, { recursive: true, force: true }));
afterEach(() => {
  vi.restoreAllMocks();
  process.env.ALLOW_DESTRUCTIVE_ACTIONS = "false";
  saveSettings({ safetyMode: "monitor" });
});
async function fixture(
  source: "sonarr" | "radarr" = "radarr",
  language = "spa",
) {
  const id = sequence++;
  const file = path.join(media, `${id}.mka`);
  await runProcess("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1",
    "-metadata:s:a:0",
    `language=${language}`,
    "-c:a",
    "flac",
    file,
  ]);
  const scan = await scanFile(file);
  saveScan(scan);
  const identity: MediaIdentity = {
    source,
    entityId: id,
    seriesId: source === "sonarr" ? 9 : undefined,
    fileId: id,
    arrPath: `/${source}/${id}.mka`,
    downloadId: `download-${id}`,
  };
  upsertMediaItem({
    source,
    arrId: id,
    title: `Fixture ${id}`,
    path: file,
    identity: String(id),
  });
  const mediaId = `${source}:${id}:${file}`;
  raw()
    .prepare(
      "UPDATE media_items SET details=?,decision=?,fingerprint=? WHERE id=?",
    )
    .run(JSON.stringify(identity), scan.decision, scan.fingerprint, mediaId);
  return { scan, identity, mediaId };
}
function enable() {
  process.env.ALLOW_DESTRUCTIVE_ACTIONS = "true";
  saveSettings({
    safetyMode: "automatic",
    quarantinePath: destination,
    retryLimit: 3,
    retryCooldownMinutes: 1,
  });
}
function mock(
  identity: MediaIdentity,
  options: {
    renamed?: boolean;
    historyCase?:
      | "missing-path"
      | "missing-download"
      | "blank-download"
      | "repeated-import"
      | "conflicting-import"
      | "repeated-grab"
      | "conflicting-grab"
      | "shared-download"
      | "unsafe-path"
      | "no-grab-metadata";
    blocklistCase?:
      | "absent"
      | "ambiguous"
      | "wrong-title"
      | "wrong-identity"
      | "wrong-protocol"
      | "wrong-indexer"
      | "old-only"
      | "unavailable";
    redownload?: boolean;
    badHistory?: boolean;
    wrongHistory?: "path" | "download" | "identity";
    failSearch?: boolean;
    failReject?: boolean;
    ambiguous?: boolean;
    wrongFile?: boolean;
    wrongCommand?: boolean;
    languages?: { id: number; name: string }[];
  } = {},
) {
  let marked = false;
  const quality = {
    quality: { id: 1, name: "SDTV", source: "television", resolution: 480 },
    revision: { version: 1, real: 0, isRepack: false },
  };
  const calls: { method: string; path: string; body: unknown }[] = [];
  const transport: ArrTransport = async (url, _key, method, body) => {
    calls.push({ method, path: url.pathname, body });
    if (method === "POST") {
      const op = operation(identity.fileId);
      const intent = url.pathname.includes("/history/failed/")
        ? "history-failed-intent"
        : (body as { name: string }).name.endsWith("Search")
          ? "replacement-search-intent"
          : "rescan-command-intent";
      expect(
        raw()
          .prepare(
            "SELECT 1 FROM operation_steps WHERE operation_id=? AND step=?",
          )
          .get(op.id, intent),
      ).toBeTruthy();
      expect(
        raw()
          .prepare("SELECT 1 FROM retry_titles WHERE identity=?")
          .get(`${identity.source}:${identity.entityId}`),
      ).toBeTruthy();
      if (intent === "replacement-search-intent")
        expect(
          raw()
            .prepare(
              "SELECT 1 FROM operation_steps WHERE operation_id=? AND step='blocklist-verified'",
            )
            .get(op.id),
        ).toBeTruthy();
    }
    const endpoint = url.pathname.replace("/api/v3", "");
    if (
      endpoint ===
      `/${identity.source === "sonarr" ? "episodefile" : "moviefile"}/${identity.fileId}`
    )
      return {
        id: options.wrongFile ? identity.fileId + 1 : identity.fileId,
        path: identity.arrPath,
        movieId: identity.entityId,
        seriesId: identity.seriesId,
        languages: options.languages,
      };
    if (endpoint === "/episode")
      return [
        {
          id: identity.entityId,
          seriesId: identity.seriesId,
          episodeFileId: identity.fileId,
          seasonNumber: 1,
          episodeNumber: 1,
          title: "Fixture episode",
        },
      ];
    if (endpoint === "/config/downloadclient")
      return { autoRedownloadFailed: Boolean(options.redownload) };
    if (endpoint === "/history") {
      expect(
        url.searchParams.has("episodeId") ||
          url.searchParams.has("movieIds") ||
          url.searchParams.has("downloadId"),
      ).toBe(true);
      const reference =
        identity.source === "sonarr"
          ? { episodeId: identity.entityId, seriesId: identity.seriesId }
          : { movieId: identity.entityId };
      const records = [
        {
          id: 1,
          eventType: "downloadFolderImported",
          sourceTitle: `Fixture.Release.${identity.entityId}`,
          downloadId: identity.downloadId,
          data: {
            droppedPath: `/downloads/complete/Fixture.Release.${identity.entityId}/original.mka`,
            importedPath:
              options.wrongHistory === "path"
                ? "/wrong/path"
                : identity.arrPath,
            imdbId: null,
            releaseGroup: null,
            unrelated: null,
            score: 7,
            extra: { present: false },
          },
          ...reference,
        },
        {
          id: 2,
          eventType: "grabbed",
          downloadId: identity.downloadId,
          sourceTitle: options.badHistory
            ? 123
            : `Fixture.Release.${identity.entityId}`,
          quality,
          data: {
            indexer: "Fixture Indexer",
            publishedDate: "2026-01-01T00:00:00Z",
            size: "123456",
            protocol: "1",
            guid: "fixture-release-guid",
            imdbId: null,
            releaseGroup: null,
          },
          ...reference,
        },
      ];
      if (options.wrongHistory === "download")
        records[1].downloadId = "unrelated-download";
      if (options.wrongHistory === "identity")
        Object.assign(
          records[1],
          identity.source === "sonarr"
            ? { episodeId: 999999 }
            : { movieId: 999999 },
        );
      const shaped = records as unknown as Record<string, unknown>[];
      const imported = shaped[0];
      const grabbed = shaped[1];
      const data = imported.data as Record<string, unknown>;
      if (options.renamed) {
        data.importedPath = identity.arrPath + ".original";
        shaped.push({
          id: 5,
          ...reference,
          eventType:
            identity.source === "sonarr"
              ? "episodeFileRenamed"
              : "movieFileRenamed",
          data: { sourcePath: data.importedPath, path: identity.arrPath },
        });
      }
      if (options.historyCase === "missing-path") delete data.importedPath;
      if (options.historyCase === "unsafe-path")
        data.importedPath = "/tv/../" + identity.arrPath;
      if (options.historyCase === "missing-download")
        delete imported.downloadId;
      if (options.historyCase === "blank-download") imported.downloadId = "";
      if (options.historyCase === "no-grab-metadata")
        grabbed.data = { releaseGroup: null };
      if (options.historyCase === "repeated-import")
        shaped.push({ ...imported, id: 3 });
      if (options.historyCase === "conflicting-import")
        shaped.push({ ...imported, id: 3, downloadId: "different" });
      if (options.historyCase === "repeated-grab")
        shaped.push({ ...grabbed, id: 4 });
      if (options.historyCase === "conflicting-grab")
        shaped.push({
          ...grabbed,
          id: 4,
          data: { ...(grabbed.data as object), size: "98765" },
        });
      if (options.historyCase === "shared-download")
        shaped.push({ ...grabbed, id: 4, episodeId: 999999, movieId: 999999 });
      // Identity-scoped lookup hides other titles; download-scoped lookup must expose them.
      const selected = options.ambiguous
        ? []
        : url.searchParams.has("downloadId")
          ? shaped.filter(
              (row) => row.downloadId === url.searchParams.get("downloadId"),
            )
          : shaped.filter((row) => row.eventType !== "grabbed");
      return { records: selected, totalRecords: selected.length };
    }
    if (endpoint === "/blocklist") {
      expect(
        url.searchParams.get(
          identity.source === "sonarr" ? "seriesIds" : "movieIds",
        ),
      ).toBe(String(identity.seriesId || identity.entityId));
      if (marked && options.blocklistCase === "unavailable")
        throw new Error("Read interrupted");
      const entry = {
        id: 400,
        sourceTitle: `Fixture.Release.${identity.entityId}`,
        seriesId: identity.seriesId,
        episodeIds: [identity.entityId],
        movieId: identity.entityId,
        protocol: "usenet",
        indexer: "Fixture Indexer",
        quality,
      };
      if (options.blocklistCase === "wrong-title")
        entry.sourceTitle = "Other.Release";
      if (options.blocklistCase === "wrong-identity") {
        entry.movieId = 99;
        entry.episodeIds = [99];
      }
      if (options.blocklistCase === "wrong-protocol")
        entry.protocol = "torrent";
      if (options.blocklistCase === "wrong-indexer")
        entry.indexer = "Other Indexer";
      const records =
        options.blocklistCase === "old-only"
          ? [entry]
          : !marked || options.blocklistCase === "absent"
            ? []
            : options.blocklistCase === "ambiguous"
              ? [entry, { ...entry, id: 401 }]
              : [entry];
      return { records, totalRecords: records.length };
    }
    if (endpoint === "/command") {
      if (
        options.failSearch &&
        (body as { name: string }).name.endsWith("Search")
      )
        throw new Error("Ambiguous transport failure");
      return { id: 77 };
    }
    if (endpoint === "/command/77")
      return { id: options.wrongCommand ? 78 : 77, status: "completed" };
    if (endpoint === "/moviefile" || endpoint === "/episodefile") return [];
    if (endpoint === "/history/failed/2") {
      marked = true;
      if (options.failReject) throw new Error("Uncertain rejection response");
      return {};
    }
    throw new Error(`Unexpected mock endpoint ${endpoint}`);
  };
  const client =
    identity.source === "sonarr"
      ? new SonarrClient("http://sonarr-fixture.test", "test-key", transport)
      : new RadarrClient("http://radarr-fixture.test", "test-key", transport);
  return { client, calls, transport };
}
const operation = (fileId: number) =>
  raw().prepare("SELECT * FROM operations WHERE file_id=?").get(fileId) as {
    id: string;
    state: string;
    error?: string;
    quarantine_id: string;
  };
describe("automatic remediation against contract mocks only", () => {
  it("refuses an inconsistent file resource before moving or mutating anything", async () => {
    const { scan, identity } = await fixture();
    enable();
    const { client, calls } = mock(identity, { wrongFile: true });
    expect(await remediate(scan, identity, client)).toBe("needs-attention");
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect((await lstat(scan.path)).isFile()).toBe(true);
  });
  it("does not reject or search after a mismatched reconciliation command", async () => {
    const { scan, identity } = await fixture();
    enable();
    const { client, calls } = mock(identity, { wrongCommand: true });
    expect(await remediate(scan, identity, client)).toBe("needs-attention");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(operation(identity.fileId).state).toBe("needs-attention");
  });
  for (const source of ["sonarr", "radarr"] as const)
    it(`${source}: quarantines, reconciles, rejects, searches once and verifies replacement`, async () => {
      const { scan, identity } = await fixture(source);
      enable();
      const { client, calls } = mock(identity);
      await remediate(scan, identity, client);
      expect(operation(identity.fileId).state).toBe("pending");
      await expect(lstat(scan.path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
      expect(
        calls.filter((call) => call.path === "/api/v3/history/failed/2"),
      ).toHaveLength(1);
      const mutations = calls.filter((call) => call.method === "POST");
      expect(mutations.map((call) => call.path)).toEqual([
        "/api/v3/command",
        "/api/v3/history/failed/2",
        "/api/v3/command",
      ]);
      const before = calls.length;
      await remediate(scan, identity, client);
      expect(calls).toHaveLength(before);
      await verifyReplacement(
        { ...scan, decision: "needs-analysis" },
        { ...identity, fileId: identity.fileId + 10000 },
      );
      expect(operation(identity.fileId).state).toBe("pending");
      await runProcess("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
        "-metadata:s:a:0",
        "language=eng",
        "-c:a",
        "flac",
        scan.path,
      ]);
      const replacement = await scanFile(scan.path);
      saveScan(replacement);
      const replacementIdentity = {
        ...identity,
        fileId: identity.fileId + 10000,
      };
      await expect(
        verifyReplacement(
          replacement,
          replacementIdentity,
          mock(replacementIdentity, { wrongFile: true }).client,
        ),
      ).rejects.toThrow("identity");
      expect(operation(identity.fileId).state).toBe("pending");
      await verifyReplacement(
        replacement,
        replacementIdentity,
        mock(replacementIdentity).client,
      );
      expect(operation(identity.fileId).state).toBe("complete");
    });
  it("Monitor Only prohibits all remediation before any mock requests", async () => {
    const { scan, identity } = await fixture();
    const { client, calls } = mock(identity);
    await expect(remediate(scan, identity, client)).rejects.toThrow("disabled");
    expect(calls).toHaveLength(0);
  });
  it("refuses conflicting Arr-owned automatic redownload without moving media", async () => {
    const { scan, identity } = await fixture();
    enable();
    const { client, calls } = mock(identity, { redownload: true });
    await remediate(scan, identity, client);
    expect(operation(identity.fileId).state).toBe("needs-attention");
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect((await lstat(scan.path)).isFile()).toBe(true);
  });
  it("ambiguous history cannot authorize quarantine or mutation", async () => {
    const { scan, identity } = await fixture();
    enable();
    const { client, calls } = mock(identity, { ambiguous: true });
    await remediate(scan, identity, client);
    expect(operation(identity.fileId).state).toBe("needs-attention");
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect((await lstat(scan.path)).isFile()).toBe(true);
  });
  it("partial Arr failure remains durable and never repeats a possibly dispatched search", async () => {
    const { scan, identity } = await fixture();
    enable();
    const { client, calls } = mock(identity, { failSearch: true });
    await remediate(scan, identity, client);
    expect(operation(identity.fileId).state).toBe("needs-attention");
    const before = calls.length;
    await remediate(scan, identity, client);
    expect(calls).toHaveLength(before);
  });
  it("never searches after uncertain rejection, including after an administrator reset", async () => {
    const { scan, identity } = await fixture();
    enable();
    const { client, calls } = mock(identity, { failReject: true });
    expect(await remediate(scan, identity, client)).toBe("needs-attention");
    expect(
      calls.filter((call) => call.path === "/api/v3/command"),
    ).toHaveLength(1);
    const op = operation(identity.fileId);
    const attention = raw()
      .prepare("SELECT id FROM attention WHERE subject=?")
      .get(op.id) as { id: string };
    resolveAttention(attention.id, "reset", "fixture-admin");
    const before = calls.length;
    expect(await remediate(scan, identity, client)).toBe("needs-attention");
    expect(calls).toHaveLength(before);
    expect(operation(identity.fileId).state).toBe("needs-attention");
  });
  it("persists per-release aliases, title limits, backoff and deliberate reset", () => {
    enable();
    expect(
      reserveReplacement("fixture:title", "release-a", 0, ["download-a"]),
    ).toBe(1);
    expect(() =>
      reserveReplacement("fixture:title", "release-a", 99999999, [
        "new-download",
      ]),
    ).toThrow("same rejected");
    expect(() =>
      reserveReplacement("fixture:title", "renamed-release", 99999999, [
        "download-a",
      ]),
    ).toThrow("same rejected");
    expect(() => reserveReplacement("fixture:title", "release-b", 1)).toThrow(
      "cooldown",
    );
    expect(reserveReplacement("fixture:title", "release-b", 60000)).toBe(2);
    expect(reserveReplacement("fixture:title", "release-c", 180000)).toBe(3);
    expect(() =>
      reserveReplacement("fixture:title", "release-d", 99999999),
    ).toThrow("retry limit");
    resetReplacement("fixture:title", "fixture-admin");
    expect(reserveReplacement("fixture:title", "release-d", 99999999)).toBe(1);
  });
});

function wire(
  identity: MediaIdentity,
  options: Parameters<typeof mock>[1] = {},
) {
  saveIntegration(
    identity.source,
    true,
    `http://${identity.source}-fixture.test`,
    encryptSecret("test-key"),
  );
  const contract = mock(identity, options);
  vi.spyOn(transportModule, "arrTransport").mockImplementation(
    contract.transport,
  );
  return contract;
}
function requestRemediation(mediaId: string, extra = {}) {
  return queueRequest(
    new Request("http://fixture/api/jobs", {
      method: "POST",
      body: JSON.stringify({ kind: "remediate", mediaId, ...extra }),
    }),
  );
}
async function runQueued(id: string) {
  const job = jobQueue.claim()!;
  expect(job.id).toBe(id);
  await executeJob(job, new AbortController().signal);
  return job;
}

describe("manual Fix & Redownload through the durable job API", () => {
  for (const source of ["sonarr", "radarr"] as const) {
    it(`${source}: queues once, preserves quarantine, rejects then searches, verifies PASS and permits explicit cleanup`, async () => {
      clearOperationFixtures();
      const { scan, identity, mediaId } = await fixture(source);
      const other = await fixture(source);
      enable();
      saveSettings({ safetyMode: "manual" });
      const { calls } = wire(identity);
      expect(manualRemediationControl(mediaId)).toMatchObject({
        eligible: true,
        state: "Ready",
      });
      expect(attentionRemediation(mediaId)?.mediaId).toBe(mediaId);
      expect(attentionRemediation(scan.path)?.mediaId).toBe(mediaId);
      const response = await requestRemediation(mediaId);
      expect(response.status).toBe(202);
      const queued = await response.json();
      expect(queued.state).toBe("Fixing");
      expect((await requestRemediation(other.mediaId)).status).toBe(400);
      expect((await lstat(other.scan.path)).isFile()).toBe(true);
      expect(await (await requestRemediation(mediaId)).json()).toEqual(queued);
      expect(manualRemediationControl(mediaId).state).toBe("Fixing");
      expect(calls).toHaveLength(0);
      await runQueued(queued.id);
      expect(manualRemediationControl(mediaId).state).toBe(
        "Replacement pending",
      );
      expect((await requestRemediation(other.mediaId)).status).toBe(400);
      expect(
        raw()
          .prepare("SELECT 1 FROM operations WHERE file_id=?")
          .get(other.identity.fileId),
      ).toBeUndefined();
      const op = operation(identity.fileId);
      const markers = raw()
        .prepare(
          "SELECT step FROM operation_steps WHERE operation_id=? ORDER BY id",
        )
        .all(op.id) as { step: string }[];
      expect(markers.map((row) => row.step)).toEqual([
        "mutation-started",
        "quarantine-intent",
        "quarantine",
        "rescan-command-intent",
        "rescan-command",
        "history-failed-intent",
        "history-failed",
        "blocklist-verified",
        "replacement-search-intent",
        "replacement-search",
      ]);
      const retained = quarantine(op.quarantine_id)!;
      const bytes = await readFile(retained.quarantine_path);
      await expect(lstat(scan.path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        calls
          .filter((call) => call.method === "POST")
          .map((call) => [call.path, call.body]),
      ).toEqual([
        [
          "/api/v3/command",
          source === "sonarr"
            ? { name: "RescanSeries", seriesId: identity.seriesId }
            : { name: "RescanMovie", movieId: identity.entityId },
        ],
        ["/api/v3/history/failed/2", undefined],
        [
          "/api/v3/command",
          source === "sonarr"
            ? { name: "EpisodeSearch", episodeIds: [identity.entityId] }
            : { name: "MoviesSearch", movieIds: [identity.entityId] },
        ],
      ]);
      const before = calls.length;
      expect(await (await requestRemediation(mediaId)).json()).toMatchObject({
        state: "Replacement pending",
      });
      expect(calls).toHaveLength(before);
      await expect(cleanupVerifiedQuarantine(retained.id)).rejects.toThrow(
        "verified PASS",
      );
      await verifyReplacement(
        { ...scan, decision: "needs-analysis" },
        { ...identity, fileId: identity.fileId + 10000 },
      );
      expect(operation(identity.fileId).state).toBe("pending");
      await runProcess("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
        "-metadata:s:a:0",
        "language=eng",
        "-c:a",
        "flac",
        scan.path,
      ]);
      const replacement = await scanFile(scan.path);
      saveScan(replacement);
      const next = { ...identity, fileId: identity.fileId + 10000 };
      wire(next);
      await verifyReplacement(replacement, next);
      raw()
        .prepare(
          "UPDATE media_items SET decision='pass',fingerprint=?,identity=?,details=? WHERE id=?",
        )
        .run(
          replacement.fingerprint,
          String(next.fileId),
          JSON.stringify(next),
          mediaId,
        );
      expect(manualRemediationControl(mediaId)).toMatchObject({
        state: "Complete",
        eligible: false,
      });
      expect(await readFile(retained.quarantine_path)).toEqual(bytes);
      const cleanup = await cleanupRequest(
        new Request("http://fixture/api/quarantine", {
          method: "DELETE",
          body: JSON.stringify({ id: retained.id }),
        }),
      );
      expect(cleanup.status).toBe(200);
      expect(
        raw()
          .prepare(
            "SELECT step FROM operation_steps WHERE operation_id=? AND step LIKE 'cleanup-%' ORDER BY id",
          )
          .all(op.id),
      ).toEqual([{ step: "cleanup-intent" }, { step: "cleanup-complete" }]);
      expect(quarantine(retained.id)?.state).toBe("cleaned");
      await expect(lstat(retained.quarantine_path)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect((await lstat(scan.path)).isFile()).toBe(true);
      await expect(cleanupVerifiedQuarantine(retained.id)).rejects.toThrow(
        "Active quarantine",
      );
    });
  }

  it("requires admin/CSRF authorization and refuses browser-supplied evidence or identity", async () => {
    const { mediaId } = await fixture();
    enable();
    vi.mocked(requireAdmin).mockRejectedValueOnce(new Error("CSRF required"));
    expect((await requestRemediation(mediaId)).status).toBe(400);
    expect(requireAdmin).toHaveBeenCalledWith(true);
    expect(
      (
        await requestRemediation(mediaId, {
          identity: {},
          scan: { decision: "fail" },
        })
      ).status,
    ).toBe(400);
    expect(
      jobQueue.list().filter((job) => job.state === "queued"),
    ).toHaveLength(0);
  });

  it("explains disabled gates and rechecks them after enqueue", async () => {
    const { mediaId, scan, identity } = await fixture();
    const { calls } = wire(identity);
    expect(manualRemediationControl(mediaId).disabledReason).toContain(
      "ALLOW_DESTRUCTIVE_ACTIONS",
    );
    expect((await requestRemediation(mediaId)).status).toBe(400);
    process.env.ALLOW_DESTRUCTIVE_ACTIONS = "true";
    expect(manualRemediationControl(mediaId).disabledReason).toContain(
      "Automatic mode",
    );
    expect((await requestRemediation(mediaId)).status).toBe(400);
    enable();
    const queued = queueManualRemediation(mediaId, "fixture-admin");
    process.env.ALLOW_DESTRUCTIVE_ACTIONS = "false";
    await runQueued(queued.id!);
    expect(manualRemediationControl(mediaId).state).toBe("Needs attention");
    expect(calls).toHaveLength(0);
    expect((await lstat(scan.path)).isFile()).toBe(true);
  });

  it("never remediates needs-analysis or stale/inconclusive evidence", async () => {
    const { scan, mediaId } = await fixture();
    enable();
    saveScan({ ...scan, decision: "needs-analysis" });
    expect((await requestRemediation(mediaId)).status).toBe(400);
    expect(manualRemediationControl(mediaId).eligible).toBe(false);
    saveScan({
      ...scan,
      tracks: scan.tracks.map((track) => ({ ...track, language: "und" })),
    });
    expect((await requestRemediation(mediaId)).status).toBe(400);
    expect((await lstat(scan.path)).isFile()).toBe(true);
  });

  it("refuses persisted, queued and live exact-file identity mismatches", async () => {
    const { scan, identity, mediaId } = await fixture();
    enable();
    raw()
      .prepare("UPDATE media_items SET identity='999999' WHERE id=?")
      .run(mediaId);
    expect((await requestRemediation(mediaId)).status).toBe(400);
    raw()
      .prepare("UPDATE media_items SET identity=? WHERE id=?")
      .run(String(identity.fileId), mediaId);
    const queued = queueManualRemediation(mediaId, "fixture-admin");
    raw()
      .prepare("UPDATE media_items SET details=? WHERE id=?")
      .run(JSON.stringify({ ...identity, downloadId: undefined }), mediaId);
    await runQueued(queued.id!);
    expect(jobQueue.get(queued.id!)?.state).toBe("needs-attention");
    const fresh = await fixture();
    const { calls } = wire(fresh.identity, { wrongFile: true });
    const next = queueManualRemediation(fresh.mediaId, "fixture-admin");
    await runQueued(next.id!);
    expect(manualRemediationControl(fresh.mediaId).state).toBe(
      "Needs attention",
    );
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect((await lstat(scan.path)).isFile()).toBe(true);
    expect((await lstat(fresh.scan.path)).isFile()).toBe(true);
  });

  it("refuses revoked worker ownership before any destructive operation", async () => {
    const { mediaId, identity, scan } = await fixture();
    enable();
    const { calls } = wire(identity);
    const queued = queueManualRemediation(mediaId, "fixture-admin");
    const job = jobQueue.claim()!;
    jobQueue.cancel(queued.id!);
    await executeJob(job, new AbortController().signal);
    expect(calls).toHaveLength(0);
    expect((await lstat(scan.path)).isFile()).toBe(true);
  });

  it("refuses a lost runtime lease", async () => {
    const { mediaId } = await fixture();
    enable();
    const lease = new RuntimeLease(raw());
    expect(lease.acquire()).toBe(true);
    attachRuntimeLease(lease);
    lease.release();
    expect(() => queueManualRemediation(mediaId, "fixture-admin")).toThrow(
      "lease",
    );
    // Leave a valid test-only runtime attached for the remainder of this file.
    expect(lease.acquire()).toBe(true);
  });
});

async function completedFixture() {
  const fixtureData = await fixture();
  enable();
  wire(fixtureData.identity);
  const queued = queueManualRemediation(fixtureData.mediaId, "fixture-admin");
  await runQueued(queued.id!);
  const retained = quarantine(
    operation(fixtureData.identity.fileId).quarantine_id,
  )!;
  await runProcess("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1",
    "-metadata:s:a:0",
    "language=eng",
    "-c:a",
    "flac",
    fixtureData.scan.path,
  ]);
  const replacement = await scanFile(fixtureData.scan.path);
  saveScan(replacement);
  const identity = {
    ...fixtureData.identity,
    fileId: fixtureData.identity.fileId + 10000,
  };
  wire(identity);
  await verifyReplacement(replacement, identity);
  return { retained, replacement, identity };
}

describe("verified quarantine cleanup refuses unsafe recovery loss", () => {
  it("retains the failed copy when replacement evidence changes or the live Arr identity mismatches", async () => {
    const { retained, replacement, identity } = await completedFixture();
    wire(identity, { wrongFile: true });
    await expect(cleanupVerifiedQuarantine(retained.id)).rejects.toThrow(
      "identity",
    );
    wire(identity);
    await writeFile(replacement.path, "changed replacement");
    await expect(cleanupVerifiedQuarantine(retained.id)).rejects.toThrow(
      "changed",
    );
    expect((await lstat(retained.quarantine_path)).isFile()).toBe(true);
    expect(quarantine(retained.id)?.state).toBe("quarantined");
  });
  it("retains changed or symlinked quarantine copies and enforces disabled safety gates", async () => {
    const { retained } = await completedFixture();
    process.env.ALLOW_DESTRUCTIVE_ACTIONS = "false";
    await expect(cleanupVerifiedQuarantine(retained.id)).rejects.toThrow(
      "disabled",
    );
    enable();
    const saved = retained.quarantine_path + ".saved";
    await rename(retained.quarantine_path, saved);
    await symlink(saved, retained.quarantine_path);
    await expect(cleanupVerifiedQuarantine(retained.id)).rejects.toThrow(
      "Unsafe",
    );
    await rm(retained.quarantine_path);
    await writeFile(retained.quarantine_path, "different copy");
    await expect(cleanupVerifiedQuarantine(retained.id)).rejects.toThrow(
      "changed",
    );
    expect((await lstat(saved)).isFile()).toBe(true);
    expect(quarantine(retained.id)?.state).toBe("quarantined");
  });
});

describe("manual remediation retains language and retry guards", () => {
  it("accepts conclusive exact Arr language failure even when ffprobe language is und", async () => {
    const { scan, identity, mediaId } = await fixture("radarr", "und");
    const evidence = {
      source: identity.source,
      entityId: identity.entityId,
      fileId: identity.fileId,
      arrPath: identity.arrPath,
      languages: ["Spanish"],
    };
    const conclusive = await scanFile(scan.path, undefined, evidence);
    expect(conclusive.decision).toBe("fail");
    saveScan(conclusive);
    raw()
      .prepare("UPDATE media_items SET decision='fail' WHERE id=?")
      .run(mediaId);
    enable();
    wire(identity, { languages: [{ id: 3, name: "Spanish" }] });
    await runQueued(queueManualRemediation(mediaId, "fixture-admin").id!);
    expect(operation(identity.fileId).state).toBe("pending");
    expect(
      (
        await lstat(
          quarantine(operation(identity.fileId).quarantine_id)!.quarantine_path,
        )
      ).isFile(),
    ).toBe(true);
  });
  it("refuses a formerly failed file whose current Arr language evidence now passes", async () => {
    const { scan, identity, mediaId } = await fixture();
    enable();
    const { calls } = wire(identity, {
      languages: [{ id: 1, name: "English" }],
    });
    await runQueued(queueManualRemediation(mediaId, "fixture-admin").id!);
    expect(manualRemediationControl(mediaId).state).toBe("Needs attention");
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect((await lstat(scan.path)).isFile()).toBe(true);
  });
  it.each(["ignored", "cooldown", "limit"])(
    "does not bypass title %s protection",
    async (guard) => {
      const { scan, identity, mediaId } = await fixture();
      enable();
      raw()
        .prepare("INSERT INTO retry_titles VALUES(?,?,?,?)")
        .run(
          `${identity.source}:${identity.entityId}`,
          guard === "limit" ? 3 : 0,
          guard === "cooldown" ? Date.now() + 60000 : 0,
          guard === "ignored" ? 1 : 0,
        );
      const { calls } = wire(identity);
      await runQueued(queueManualRemediation(mediaId, "fixture-admin").id!);
      expect(operation(identity.fileId).state).toBe("needs-attention");
      expect(calls.every((call) => call.method === "GET")).toBe(true);
      expect((await lstat(scan.path)).isFile()).toBe(true);
    },
  );
});

async function readFailure(source: "sonarr" | "radarr" = "sonarr") {
  const data = await fixture(source);
  enable();
  wire(data.identity, { badHistory: true });
  await runQueued(queueManualRemediation(data.mediaId, "fixture-admin").id!);
  expect(operation(data.identity.fileId).state).toBe("needs-attention");
  return { ...data, op: operation(data.identity.fileId) };
}

describe("explicit pre-mutation retry", () => {
  for (const source of ["sonarr", "radarr"] as const) {
    it(`${source}: reuses the failed operation only after explicit authorization and never duplicates mutations`, async () => {
      clearOperationFixtures();
      const { identity, mediaId, op, scan } = await readFailure(source);
      saveSettings({ safetyMode: "manual" });
      expect(manualRemediationControl(mediaId)).toMatchObject({
        state: "Needs attention",
        retryOperationId: op.id,
        reason: `${source === "sonarr" ? "Sonarr" : "Radarr"} history response could not be parsed`,
      });
      const { calls } = wire(identity);
      // The normal action still refuses replay.
      expect(queueManualRemediation(mediaId, "fixture-admin").state).toBe(
        "Needs attention",
      );
      expect(calls).toHaveLength(0);
      const retry = await (
        await requestRemediation(mediaId, { retryOperationId: op.id })
      ).json();
      expect(retry.state).toBe("Fixing");
      expect(
        await (
          await requestRemediation(mediaId, { retryOperationId: op.id })
        ).json(),
      ).toEqual(retry);
      await runQueued(retry.id);
      expect(operation(identity.fileId)).toMatchObject({
        id: op.id,
        state: "pending",
      });
      expect(
        calls.filter((call) => call.method === "POST").map((call) => call.path),
      ).toEqual([
        "/api/v3/command",
        "/api/v3/history/failed/2",
        "/api/v3/command",
      ]);
      expect(
        raw()
          .prepare(
            "SELECT COUNT(*) n FROM operations WHERE source=? AND entity_id=?",
          )
          .get(source, identity.entityId),
      ).toEqual({ n: 1 });
      expect(
        manualRemediationControl(mediaId).retryOperationId,
      ).toBeUndefined();
      await expect(
        queuePreMutationRetry(mediaId, op.id, "fixture-admin"),
      ).rejects.toThrow("not proven");
      await expect(lstat(scan.path)).rejects.toMatchObject({ code: "ENOENT" });
    });
  }
  it("recognizes the legacy nullable-metadata parser failure without clearing old evidence", async () => {
    const { identity, mediaId, op } = await readFailure();
    raw()
      .prepare("DELETE FROM operation_steps WHERE operation_id=?")
      .run(op.id);
    const legacy = JSON.stringify(
      ["imdbId", "releaseGroup"].map((field) => ({
        code: "invalid_type",
        expected: "string",
        received: "null",
        path: ["records", 0, "data", field],
        message: "Expected string, received null",
      })),
    );
    raw()
      .prepare("UPDATE operations SET error=? WHERE id=?")
      .run(legacy, op.id);
    expect(manualRemediationControl(mediaId).retryOperationId).toBe(op.id);
    const oldEvidence = raw()
      .prepare("SELECT evidence FROM operations WHERE id=?")
      .get(op.id);
    wire(identity);
    await runQueued(
      (await queuePreMutationRetry(mediaId, op.id, "fixture-admin")).id,
    );
    expect(
      raw().prepare("SELECT evidence FROM operations WHERE id=?").get(op.id),
    ).toEqual(oldEvidence);
    expect(operation(identity.fileId).state).toBe("pending");
  });
  it.each([
    "quarantine",
    "rescan-command",
    "history-failed",
    "replacement-search",
    "mutation-started",
    "quarantine-intent",
    "rescan-command-intent",
    "history-failed-intent",
    "replacement-search-intent",
    "cleanup-intent",
    "unknown-step",
    "quarantine-id",
    "release-key",
    "reservation",
    "orphan-quarantine",
    "no-proof",
  ])("refuses unsafe or uncertain history: %s", async (blocker) => {
    const { identity, mediaId, op, scan } = await readFailure();
    if (blocker === "quarantine-id")
      raw()
        .prepare("UPDATE operations SET quarantine_id='copy' WHERE id=?")
        .run(op.id);
    else if (blocker === "release-key")
      raw()
        .prepare("UPDATE operations SET release_key='reserved' WHERE id=?")
        .run(op.id);
    else if (blocker === "reservation")
      raw()
        .prepare("INSERT INTO retry_titles VALUES(?,1,0,0)")
        .run(`${identity.source}:${identity.entityId}`);
    else if (blocker === "orphan-quarantine")
      raw()
        .prepare("INSERT INTO quarantines VALUES(?,?,?,?,?,?,?)")
        .run(
          `orphan-${op.id}`,
          scan.path,
          "/unused",
          "{}",
          "needs-attention",
          "fixture",
          null,
        );
    else if (blocker === "no-proof")
      raw()
        .prepare("DELETE FROM operation_steps WHERE operation_id=?")
        .run(op.id);
    else
      raw()
        .prepare(
          "INSERT INTO operation_steps(operation_id,step,result,created_at) VALUES(?,?,?,?)",
        )
        .run(op.id, blocker, "{}", "fixture");
    const { calls } = wire(identity);
    expect(manualRemediationControl(mediaId).retryOperationId).toBeUndefined();
    await expect(
      queuePreMutationRetry(mediaId, op.id, "fixture-admin"),
    ).rejects.toThrow("not proven");
    expect(calls).toHaveLength(0);
    expect((await lstat(scan.path)).isFile()).toBe(true);
  });
  it("rechecks safety, current file evidence and live exact identity on explicit retry", async () => {
    const { identity, mediaId, op, scan } = await readFailure();
    process.env.ALLOW_DESTRUCTIVE_ACTIONS = "false";
    await expect(
      queuePreMutationRetry(mediaId, op.id, "fixture-admin"),
    ).rejects.toThrow("disabled");
    enable();
    wire(identity, { wrongFile: true });
    await expect(
      queuePreMutationRetry(mediaId, op.id, "fixture-admin"),
    ).rejects.toThrow("identity");
    wire(identity);
    saveScan({ ...scan, decision: "needs-analysis" });
    expect(manualRemediationControl(mediaId).eligible).toBe(false);
    await expect(
      queuePreMutationRetry(mediaId, op.id, "fixture-admin"),
    ).rejects.toThrow("evidence");
    saveScan(scan);
    await writeFile(scan.path, "changed active file");
    await expect(
      queuePreMutationRetry(mediaId, op.id, "fixture-admin"),
    ).rejects.toThrow("changed");
  });
  it.each(["path", "download", "identity"] as const)(
    "never relaxes history %s correlation",
    async (wrongHistory) => {
      const { identity, mediaId, scan } = await fixture("sonarr");
      enable();
      const { calls } = wire(identity, { wrongHistory });
      await runQueued(queueManualRemediation(mediaId, "fixture-admin").id!);
      expect(operation(identity.fileId).state).toBe("needs-attention");
      expect(calls.every((call) => call.method === "GET")).toBe(true);
      expect((await lstat(scan.path)).isFile()).toBe(true);
    },
  );
  it("never renders arbitrary stored errors as a visible remediation reason", async () => {
    const { mediaId, op } = await readFailure();
    raw()
      .prepare("UPDATE operations SET error=? WHERE id=?")
      .run("secret-api-key huge-server-body".repeat(500), op.id);
    const reason = manualRemediationControl(mediaId).reason!;
    expect(reason.length).toBeLessThan(200);
    expect(reason).not.toContain("secret-api-key");
  });
});

function clearOperationFixtures() {
  // This test file shares one isolated database; manual admission is global.
  raw().exec(
    "DELETE FROM operation_steps; DELETE FROM operations; DELETE FROM jobs;",
  );
}

describe("realistic scoped history and blocklist contracts", () => {
  for (const source of ["sonarr", "radarr"] as const) {
    it.each([
      "missing-path",
      "missing-download",
      "blank-download",
      "repeated-import",
      "conflicting-import",
      "conflicting-grab",
      "shared-download",
      "unsafe-path",
      "no-grab-metadata",
    ] as const)(
      `${source}: refuses %s before mutation`,
      async (historyCase) => {
        const { scan, identity } = await fixture(source);
        enable();
        const { client, calls } = mock(identity, { historyCase });
        expect(await remediate(scan, identity, client)).toBe("needs-attention");
        expect(calls.every((call) => call.method === "GET")).toBe(true);
        expect((await lstat(scan.path)).isFile()).toBe(true);
      },
    );
    it.each(["repeated-grab"] as const)(
      `${source}: identical repeated release evidence remains correlated (%s)`,
      async (historyCase) => {
        const { scan, identity } = await fixture(source);
        enable();
        expect(
          await remediate(
            scan,
            identity,
            mock(identity, { historyCase }).client,
          ),
        ).toBe("pending");
      },
    );
    it.each([
      "absent",
      "ambiguous",
      "wrong-title",
      "wrong-identity",
      "wrong-protocol",
      "wrong-indexer",
      "old-only",
      "unavailable",
    ] as const)(
      `${source}: no search when new blocklist proof is %s`,
      async (blocklistCase) => {
        const { scan, identity, mediaId } = await fixture(source);
        enable();
        const { client, calls } = mock(identity, { blocklistCase });
        expect(await remediate(scan, identity, client)).toBe("needs-attention");
        expect(
          calls.filter((call) => call.path.includes("/history/failed/")),
        ).toHaveLength(1);
        expect(
          calls.filter((call) =>
            (call.body as { name?: string })?.name?.endsWith("Search"),
          ),
        ).toHaveLength(0);
        expect(
          manualRemediationControl(mediaId).retryOperationId,
        ).toBeUndefined();
        expect(
          (
            await lstat(
              quarantine(operation(identity.fileId).quarantine_id)!
                .quarantine_path,
            )
          ).isFile(),
        ).toBe(true);
      },
    );
  }
  it("Manual mode refuses a direct remediation call without the admitted durable job", async () => {
    clearOperationFixtures();
    const { scan, identity } = await fixture();
    enable();
    saveSettings({ safetyMode: "manual" });
    const { client, calls } = mock(identity);
    await expect(remediate(scan, identity, client)).rejects.toThrow(
      "explicitly authorized job",
    );
    expect(calls).toHaveLength(0);
  });
});

describe("rename failure retry and legacy admission", () => {
  for (const source of ["sonarr", "radarr"] as const) {
    it(`${source}: retries the old pre-mutation rename failure without replacing its evidence`, async () => {
      clearOperationFixtures();
      const { identity, mediaId, scan } = await fixture(source);
      enable();
      saveSettings({ safetyMode: "manual" });
      wire(identity, { renamed: true });
      // Reproduce v0.2.7's direct-only correlation failure against unchanged
      // Arr rename history, then restore the corrected correlation implementation.
      const oldRule = vi
        .spyOn(historyModule, "correlateRelease")
        .mockRejectedValueOnce(new Error("Ambiguous imported release history"));
      await runQueued(queueManualRemediation(mediaId, "fixture-admin").id!);
      oldRule.mockRestore();
      const op = operation(identity.fileId);
      const original = raw()
        .prepare("SELECT evidence,error FROM operations WHERE id=?")
        .get(op.id);
      expect(op.state).toBe("needs-attention");
      expect(
        raw()
          .prepare("SELECT step FROM operation_steps WHERE operation_id=?")
          .all(op.id),
      ).toEqual([{ step: "pre-mutation-failure" }]);
      expect(manualRemediationControl(mediaId).retryOperationId).toBe(op.id);
      const { calls } = wire(identity, { renamed: true });
      await runQueued(
        (await queuePreMutationRetry(mediaId, op.id, "fixture-admin")).id,
      );
      expect(operation(identity.fileId)).toMatchObject({
        id: op.id,
        state: "pending",
      });
      expect(
        raw()
          .prepare("SELECT evidence,error FROM operations WHERE id=?")
          .get(op.id),
      ).toEqual(original);
      expect(
        calls.filter((c) =>
          (c.body as { name?: string })?.name?.endsWith("Search"),
        ),
      ).toHaveLength(1);
      await expect(lstat(scan.path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(() => requireManualAdmission()).toThrow("only one item");
    });
  }
  const legacy =
    "Disable Arr automatic failed-download redownload before using Automatic mode";
  async function legacyFailure() {
    clearOperationFixtures();
    const data = await readFailure();
    raw()
      .prepare("DELETE FROM operation_steps WHERE operation_id=?")
      .run(data.op.id);
    raw()
      .prepare("UPDATE operations SET error=? WHERE id=?")
      .run(legacy, data.op.id);
    saveSettings({ safetyMode: "manual" });
    return data;
  }
  it("exact legacy refusal no longer blocks admission and can retry without erasing evidence", async () => {
    const { identity, mediaId, op } = await legacyFailure();
    const evidence = raw()
      .prepare("SELECT evidence FROM operations WHERE id=?")
      .get(op.id);
    expect(() => requireManualAdmission()).not.toThrow();
    expect(manualRemediationControl(mediaId).retryOperationId).toBe(op.id);
    wire(identity);
    await runQueued(
      (await queuePreMutationRetry(mediaId, op.id, "fixture-admin")).id,
    );
    expect(operation(identity.fileId).state).toBe("pending");
    expect(
      raw().prepare("SELECT evidence FROM operations WHERE id=?").get(op.id),
    ).toEqual(evidence);
    expect(() => requireManualAdmission()).toThrow("only one item");
  });
  it.each([
    "different-error",
    "empty-release-key",
    "empty-quarantine-id",
    "wrong-state",
    "release-key",
    "quarantine-id",
    "quarantine-intent",
    "rescan-command-intent",
    "history-failed-intent",
    "replacement-search-intent",
    "mutation-started",
    "unknown-step",
    "title-reservation",
    "release-reservation",
    "orphan-quarantine",
  ])("legacy signature still blocks with %s", async (blocker) => {
    const { identity, op, scan } = await legacyFailure();
    if (blocker === "empty-release-key")
      raw()
        .prepare("UPDATE operations SET release_key='' WHERE id=?")
        .run(op.id);
    else if (blocker === "empty-quarantine-id")
      raw()
        .prepare("UPDATE operations SET quarantine_id='' WHERE id=?")
        .run(op.id);
    else if (blocker === "different-error")
      raw()
        .prepare("UPDATE operations SET error=? WHERE id=?")
        .run(legacy + ".", op.id);
    else if (blocker === "wrong-state")
      raw()
        .prepare("UPDATE operations SET state='pending' WHERE id=?")
        .run(op.id);
    else if (blocker === "release-key")
      raw()
        .prepare("UPDATE operations SET release_key='reserved' WHERE id=?")
        .run(op.id);
    else if (blocker === "quarantine-id")
      raw()
        .prepare("UPDATE operations SET quarantine_id='copy' WHERE id=?")
        .run(op.id);
    else if (blocker === "title-reservation")
      raw()
        .prepare("INSERT INTO retry_titles VALUES(?,1,0,0)")
        .run(`${identity.source}:${identity.entityId}`);
    else if (blocker === "release-reservation") {
      reserveReplacement(
        `${identity.source}:${identity.entityId}`,
        `legacy-release-${identity.entityId}`,
        Date.now(),
      );
      raw()
        .prepare("DELETE FROM retry_titles WHERE identity=?")
        .run(`${identity.source}:${identity.entityId}`);
    } else if (blocker === "orphan-quarantine")
      raw()
        .prepare("INSERT INTO quarantines VALUES(?,?,?,?,?,?,?)")
        .run(
          `legacy-${op.id}`,
          scan.path,
          "/unused",
          "{}",
          "needs-attention",
          "fixture",
          null,
        );
    else
      raw()
        .prepare(
          "INSERT INTO operation_steps(operation_id,step,result,created_at) VALUES(?,?,?,?)",
        )
        .run(op.id, blocker, "{}", "fixture");
    const stored = raw()
      .prepare("SELECT * FROM operations WHERE id=?")
      .get(op.id) as RetryOperation;
    expect(preMutationRetryProof(stored)).toBe(false);
    expect(() => requireManualAdmission()).toThrow("only one item");
  });
});
