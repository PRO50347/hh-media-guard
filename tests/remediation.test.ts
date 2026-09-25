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
    redownload?: boolean;
    failSearch?: boolean;
    failReject?: boolean;
    ambiguous?: boolean;
    wrongFile?: boolean;
    wrongCommand?: boolean;
    languages?: { id: number; name: string }[];
  } = {},
) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const transport: ArrTransport = async (url, _key, method, body) => {
    calls.push({ method, path: url.pathname, body });
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
      const reference =
        identity.source === "sonarr"
          ? { episodeId: identity.entityId }
          : { movieId: identity.entityId };
      const records = [
        {
          id: 1,
          eventType: "downloadFolderImported",
          downloadId: identity.downloadId,
          data: { droppedPath: identity.arrPath },
          ...reference,
        },
        {
          id: 2,
          eventType: "grabbed",
          downloadId: identity.downloadId,
          sourceTitle: `Fixture.Release.${identity.entityId}`,
          data: { indexerId: "1" },
          ...reference,
        },
      ];
      return {
        records: options.ambiguous ? [] : records,
        totalRecords: options.ambiguous ? 0 : records.length,
      };
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
      const { scan, identity, mediaId } = await fixture(source);
      enable();
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
      expect(await (await requestRemediation(mediaId)).json()).toEqual(queued);
      expect(manualRemediationControl(mediaId).state).toBe("Fixing");
      expect(calls).toHaveLength(0);
      await runQueued(queued.id);
      expect(manualRemediationControl(mediaId).state).toBe(
        "Replacement pending",
      );
      const op = operation(identity.fileId);
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
