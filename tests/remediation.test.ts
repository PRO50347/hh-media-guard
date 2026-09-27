import {
  beforeAll,
  beforeEach,
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
  readFile,
  unlink,
  writeFile,
  rename,
  symlink,
  readdir,
} from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { createHash } from "node:crypto";
import * as scannerModule from "../src/lib/scanner";
import { tmpdir } from "node:os";
import path from "node:path";
import { SafeError } from "../src/lib/safe-error";
import { RadarrClient, SonarrClient } from "../src/lib/clients";
import { type ArrTransport } from "../src/lib/arr-transport";
import * as transportModule from "../src/lib/arr-transport";
import * as quarantineModule from "../src/lib/quarantine";
import {
  remediate,
  verifyReplacement,
  type MediaIdentity,
} from "../src/lib/remediation";
import {
  addMapping,
  getSettings,
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
import {
  queueManualRemediation,
  queuePreMutationRetry,
  manualRemediationControl,
} from "../src/lib/manual-remediation";
import { requireManualAdmission } from "../src/lib/remediation-admission";
import {
  preMutationRetryProof,
  type RetryOperation,
} from "../src/lib/remediation-retry";
import { reserveReplacement, resetReplacement } from "../src/lib/retries";
import * as runtimeModule from "../src/lib/runtime-lease";
import { requireAdmin } from "../src/lib/auth";
import { executeJob } from "../src/lib/worker";
import { cleanupVerifiedQuarantine } from "../src/lib/quarantine-cleanup";
import { POST } from "../src/app/api/jobs/route";
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));
vi.mock("../src/lib/auth", () => ({
  requireAdmin: vi.fn(async () => ({ username: "fixture-admin" })),
}));
let root: string, media: string, destination: string;
let sequence = 1000;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "hh-delete-remediation-"));
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
beforeEach(() => {
  raw().exec(
    "DELETE FROM operation_steps; DELETE FROM operations; DELETE FROM jobs; DELETE FROM retry_titles; DELETE FROM retry_releases; DELETE FROM quarantines; DELETE FROM attention;",
  );
  process.env.ALLOW_DESTRUCTIVE_ACTIONS = "true";
  saveSettings({
    safetyMode: "manual",
    quarantinePath: destination,
    retryLimit: 3,
    retryCooldownMinutes: 1,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  process.env.ALLOW_DESTRUCTIVE_ACTIONS = "false";
  saveSettings({ safetyMode: "monitor" });
});
afterAll(() => rm(root, { recursive: true, force: true }));
async function audio(file: string, language = "spa") {
  await runProcess("ffmpeg", [
    "-y",
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
}
async function fixture(source: "sonarr" | "radarr" = "sonarr") {
  const id = sequence++,
    file = path.join(media, `${id}.mka`);
  await audio(file);
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
    title:
      source === "sonarr" ? "ALF S04E01 — Baby, Come Back" : "Fixture movie",
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
type Options = {
  rename?: boolean;
  languages?: string[];
  deleteOutcome?:
    | "404"
    | "uncertain"
    | "still-reported"
    | "path-remains"
    | "path-reported";
  blocklist?: "absent" | "ambiguous";
  failSearch?: boolean;
  shared?: boolean;
  pack?: boolean;
  badHistory?: boolean;
  changeBeforeDelete?: boolean;
};
function wire(
  data: Awaited<ReturnType<typeof fixture>>,
  options: Options = {},
) {
  const { identity, scan } = data;
  let deleted = false,
    marked = false,
    reads = 0;
  const calls: { method: string; path: string; body: unknown }[] = [];
  const quality = {
    quality: { id: 5, name: "WEBDL-720p" },
    revision: { version: 1, real: 0, isRepack: false },
  };
  const file = {
    id: identity.fileId,
    movieId: identity.entityId,
    seriesId: identity.seriesId,
    path: identity.arrPath,
    languages: (options.languages || ["Spanish"]).map((name, i) => ({
      id: i + 1,
      name,
    })),
  };
  const transport: ArrTransport = async (url, _key, method, body) => {
    const endpoint = url.pathname.replace("/api/v3", "");
    calls.push({ method, path: endpoint, body });
    const fileEndpoint = `/${identity.source === "sonarr" ? "episodefile" : "moviefile"}/${identity.fileId}`;
    if (method === "DELETE" && endpoint === fileEndpoint) {
      const op = operation(identity.fileId);
      const steps = markers(op.id);
      expect(steps).toContain("backup-copy");
      expect(steps).toContain("arr-delete-intent");
      expect(
        await readFile(quarantine(op.quarantine_id!)!.quarantine_path),
      ).toEqual(await readFile(scan.path));
      // The active file MUST still exist until Arr handles this exact-ID DELETE.
      expect((await lstat(scan.path)).isFile()).toBe(true);
      if (options.deleteOutcome === "404")
        throw new SafeError("arr.http.404", "Arr returned HTTP 404");
      if (options.deleteOutcome !== "path-remains") await unlink(scan.path);
      deleted = options.deleteOutcome !== "still-reported";
      if (options.deleteOutcome === "uncertain")
        throw new Error("Response lost after deletion");
      return undefined; // real no-content success
    }
    if (method === "GET" && endpoint === fileEndpoint) {
      reads++;
      if (deleted) throw new SafeError("arr.http.404", "Arr returned HTTP 404");
      if (options.changeBeforeDelete && reads >= 4)
        return { ...file, id: file.id + 1 };
      return file;
    }
    if (endpoint === "/episode")
      return [
        {
          id: identity.entityId,
          seriesId: identity.seriesId,
          episodeFileId: deleted ? 0 : file.id,
          seasonNumber: 4,
          episodeNumber: 1,
          title: "Baby, Come Back",
        },
        ...(options.pack
          ? [
              {
                id: identity.entityId + 1,
                seriesId: identity.seriesId,
                episodeFileId: file.id,
                seasonNumber: 4,
                episodeNumber: 2,
                title: "Other",
              },
            ]
          : []),
      ];
    if (endpoint === "/episodefile" || endpoint === "/moviefile")
      return !deleted
        ? [file]
        : options.deleteOutcome === "path-reported"
          ? [{ ...file, id: file.id + 99 }]
          : [];
    if (endpoint === "/config/downloadclient")
      return { autoRedownloadFailed: false };
    if (endpoint === "/history") {
      const ref =
        identity.source === "sonarr"
          ? { episodeId: identity.entityId, seriesId: identity.seriesId }
          : { movieId: identity.entityId };
      const original = options.rename
        ? identity.arrPath + ".WEBDL-720p"
        : identity.arrPath;
      const imported = {
        id: 1,
        ...ref,
        eventType: "downloadFolderImported",
        downloadId: identity.downloadId,
        sourceTitle: "Alf S04E01 German 720p WEB x264-TVNATiON",
        data: {
          droppedPath: "/downloads/ALF/original.mkv",
          importedPath: original,
          releaseGroup: null,
        },
      };
      const grabbed = {
        id: 2,
        ...ref,
        eventType: "grabbed",
        downloadId: identity.downloadId,
        sourceTitle: imported.sourceTitle,
        quality,
        data: {
          indexer: "Fixture",
          size: "1000",
          protocol: "1",
          publishedDate: "2026-01-01T00:00:00Z",
          imdbId: null,
          releaseGroup: null,
        },
      };
      const records = options.badHistory
        ? []
        : url.searchParams.has("downloadId")
          ? [
              grabbed,
              ...(options.shared
                ? [{ ...grabbed, id: 7, episodeId: 999999, movieId: 999999 }]
                : []),
            ]
          : [
              imported,
              ...(options.rename
                ? [
                    {
                      id: 3,
                      ...ref,
                      eventType:
                        identity.source === "sonarr"
                          ? "episodeFileRenamed"
                          : "movieFileRenamed",
                      data: { sourcePath: original, path: identity.arrPath },
                    },
                  ]
                : []),
            ];
      return { records, totalRecords: records.length };
    }
    if (endpoint === "/blocklist") {
      const entry = {
        id: 10,
        movieId: identity.entityId,
        seriesId: identity.seriesId,
        episodeIds: [identity.entityId],
        sourceTitle: "Alf S04E01 German 720p WEB x264-TVNATiON",
        indexer: "Fixture",
        protocol: "usenet",
        quality,
      };
      const records =
        !marked || options.blocklist === "absent"
          ? []
          : options.blocklist === "ambiguous"
            ? [entry, { ...entry, id: 11 }]
            : [entry];
      return { records, totalRecords: records.length };
    }
    if (endpoint === "/history/failed/2" && method === "POST") {
      expect(deleted).toBe(true);
      expect(markers(operation(identity.fileId).id)).toContain(
        "history-failed-intent",
      );
      marked = true;
      return {};
    }
    if (endpoint === "/command" && method === "POST") {
      expect(deleted && marked).toBe(true);
      expect(markers(operation(identity.fileId).id)).toContain(
        "blocklist-verified",
      );
      expect(markers(operation(identity.fileId).id)).toContain(
        "replacement-search-intent",
      );
      expect(body).toEqual(
        identity.source === "sonarr"
          ? { name: "EpisodeSearch", episodeIds: [identity.entityId] }
          : { name: "MoviesSearch", movieIds: [identity.entityId] },
      );
      if (options.failSearch) throw new Error("Unknown search outcome");
      return { id: 77 };
    }
    throw new Error(`Unexpected endpoint ${method} ${endpoint}`);
  };
  saveIntegration(
    identity.source,
    true,
    `http://${identity.source}-fixture.test`,
    encryptSecret("fixture-key"),
  );
  vi.spyOn(transportModule, "arrTransport").mockImplementation(transport);
  const client =
    identity.source === "sonarr"
      ? new SonarrClient("http://sonarr-fixture.test", "fixture-key", transport)
      : new RadarrClient(
          "http://radarr-fixture.test",
          "fixture-key",
          transport,
        );
  return { calls, client, file, transport };
}
function operation(fileId: number) {
  return raw()
    .prepare(
      "SELECT * FROM operations WHERE file_id=? ORDER BY created_at DESC LIMIT 1",
    )
    .get(fileId) as RetryOperation;
}
function markers(id: string) {
  return (
    raw()
      .prepare(
        "SELECT step FROM operation_steps WHERE operation_id=? ORDER BY id",
      )
      .all(id) as { step: string }[]
  ).map((s) => s.step);
}
async function run(id: string) {
  const job = jobQueue.claim()!;
  expect(job.id).toBe(id);
  await executeJob(job, new AbortController().signal);
  return jobQueue.get(id)!;
}
async function fix(data: Awaited<ReturnType<typeof fixture>>) {
  const response = await POST(
    new Request("http://fixture/api/jobs", {
      method: "POST",
      body: JSON.stringify({ kind: "remediate", mediaId: data.mediaId }),
    }),
  );
  expect(response.status).toBe(202);
  const result = await response.json();
  await run(result.id);
  return result.id as string;
}
const mutations = (calls: ReturnType<typeof wire>["calls"]) =>
  calls.filter((c) => c.method !== "GET");
async function replacement(
  data: Awaited<ReturnType<typeof fixture>>,
  language = "eng",
) {
  await audio(data.scan.path, language);
  const identity = { ...data.identity, fileId: data.identity.fileId + 10000 };
  const scan = await scanFile(data.scan.path);
  saveScan(scan);
  raw()
    .prepare(
      "UPDATE media_items SET identity=?,details=?,fingerprint=?,decision=? WHERE id=?",
    )
    .run(
      String(identity.fileId),
      JSON.stringify(identity),
      scan.fingerprint,
      scan.decision,
      data.mediaId,
    );
  const next = { ...data, identity, scan };
  const contract = wire(next, {
    languages: [
      language === "eng"
        ? "English"
        : language === "spa"
          ? "Spanish"
          : "Unknown",
    ],
  });
  const base = contract.transport;
  const transport: ArrTransport = async (url, ...args) => {
    if (url.pathname.endsWith(`/${data.identity.fileId}`))
      throw new SafeError("arr.http.404", "Arr returned HTTP 404");
    return base(url, ...args);
  };
  vi.spyOn(transportModule, "arrTransport").mockImplementation(transport);
  const client =
    identity.source === "sonarr"
      ? new SonarrClient("http://fixture.test", "key", transport)
      : new RadarrClient("http://fixture.test", "key", transport);
  return { ...next, client };
}

describe("backup-first exact Arr DELETE state machine", () => {
  for (const source of ["sonarr", "radarr"] as const) {
    it(`${source}: fresh scan, backup, exact DELETE, verified removal, blocklist, one search, fresh replacement PASS, explicit cleanup`, async () => {
      const data = await fixture(source);
      const other = await fixture(source);
      const contract = wire(data, { rename: true });
      const id = queueManualRemediation(data.mediaId, "fixture-admin").id!;
      expect(manualRemediationControl(data.mediaId).state).toBe(
        "Checking current file...",
      );
      expect(() =>
        queueManualRemediation(other.mediaId, "fixture-admin"),
      ).toThrow("only one item");
      expect(queueManualRemediation(data.mediaId, "fixture-admin").id).toBe(id);
      await run(id);
      const op = operation(data.identity.fileId);
      expect(op.state).toBe("pending");
      expect(mutations(contract.calls).map((call) => call.path)).toEqual([
        `/${source === "sonarr" ? "episodefile" : "moviefile"}/${data.identity.fileId}`,
        "/history/failed/2",
        "/command",
      ]);
      expect(markers(op.id)).toEqual([
        "mutation-started",
        "backup-copy-intent",
        "backup-copy",
        "arr-delete-intent",
        "arr-delete-verified",
        "history-failed-intent",
        "history-failed",
        "blocklist-verified",
        "replacement-search-intent",
        "replacement-search",
      ]);
      expect(() =>
        queueManualRemediation(other.mediaId, "fixture-admin"),
      ).toThrow("only one item");
      expect((await lstat(other.scan.path)).isFile()).toBe(true);
      const backup = quarantine(op.quarantine_id!)!;
      const bytes = await readFile(backup.quarantine_path);
      await expect(cleanupVerifiedQuarantine(backup.id)).rejects.toThrow(
        "verified PASS",
      );
      const next = await replacement(data);
      await verifyReplacement(next.scan, next.identity, next.client);
      expect(operation(data.identity.fileId).state).toBe("complete");
      expect(await readFile(backup.quarantine_path)).toEqual(bytes);
      await cleanupVerifiedQuarantine(backup.id);
      expect(markers(op.id).slice(-2)).toEqual([
        "cleanup-intent",
        "cleanup-complete",
      ]);
      await expect(lstat(backup.quarantine_path)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect((await lstat(data.scan.path)).isFile()).toBe(true);
    });
    it(`${source}: old fingerprint is refreshed before mutation`, async () => {
      const data = await fixture(source);
      const old = { ...data.scan, fingerprint: "old-v1-fingerprint" };
      saveScan(old);
      raw()
        .prepare("UPDATE media_items SET fingerprint=? WHERE id=?")
        .run(old.fingerprint, data.mediaId);
      wire(data);
      await fix(data);
      const evidence = JSON.parse(operation(data.identity.fileId).evidence);
      expect(evidence.scan.fingerprint).toBe(data.scan.fingerprint);
      expect(evidence.scan.fingerprint).not.toBe(old.fingerprint);
      expect(evidence.scan.arrFileEvidence.languages).toEqual(["Spanish"]);
    });
    it.each(["pass", "needs-analysis"] as const)(
      `${source}: fresh %s stops with zero mutation/reservation`,
      async (decision) => {
        const data = await fixture(source);
        if (decision === "needs-analysis") await audio(data.scan.path, "und");
        const { calls } = wire(data, {
          languages: decision === "pass" ? ["English"] : [],
        });
        const id = await fix(data);
        expect(mutations(calls)).toHaveLength(0);
        expect(operation(data.identity.fileId)).toBeUndefined();
        expect(
          raw().prepare("SELECT count(*) n FROM retry_titles").get(),
        ).toEqual({ n: 0 });
        expect(jobQueue.get(id)?.currentItem).toBe(
          decision === "pass"
            ? "File now passes; no replacement needed."
            : "Fresh scan needs analysis.",
        );
        expect(manualRemediationControl(data.mediaId).state).toBe(
          decision === "pass"
            ? "No fix needed — file now passes"
            : "Fresh scan needs analysis",
        );
      },
    );
    it.each([
      "404",
      "uncertain",
      "still-reported",
      "path-remains",
      "path-reported",
    ] as const)(
      `${source}: DELETE %s cannot search or replay`,
      async (deleteOutcome) => {
        const data = await fixture(source);
        const { calls } = wire(data, { deleteOutcome });
        await fix(data);
        const op = operation(data.identity.fileId);
        expect(op.state).toBe("needs-attention");
        expect(markers(op.id)).toContain("arr-delete-intent");
        expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(
          1,
        );
        expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
        expect(
          (
            await lstat(quarantine(op.quarantine_id!)!.quarantine_path)
          ).isFile(),
        ).toBe(true);
        expect(
          queueManualRemediation(data.mediaId, "fixture-admin").state,
        ).toBe("Needs attention");
        await expect(
          queuePreMutationRetry(data.mediaId, op.id, "fixture-admin"),
        ).rejects.toThrow("not proven");
        expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(
          1,
        );
      },
    );
  }
  it.each([
    "backup",
    "root",
    "identity-before-delete",
    "identity-before-action",
    "shared",
    "pack",
    "blocklist-absent",
    "blocklist-ambiguous",
    "search-uncertain",
  ])("fails closed: %s", async (failure) => {
    const data = await fixture();
    const options: Options = {
      changeBeforeDelete: failure === "identity-before-delete",
      shared: failure === "shared",
      pack: failure === "pack",
      blocklist:
        failure === "blocklist-absent"
          ? "absent"
          : failure === "blocklist-ambiguous"
            ? "ambiguous"
            : undefined,
      failSearch: failure === "search-uncertain",
    };
    const contract = wire(data, options);
    if (failure === "identity-before-action") contract.file.id++;
    if (failure === "backup")
      vi.spyOn(quarantineModule, "preserveRecoveryCopy").mockRejectedValue(
        new Error("Incomplete backup"),
      );
    if (failure === "root")
      saveSettings({ quarantinePath: path.join(root, "missing") });
    await fix(data);
    if (
      [
        "backup",
        "root",
        "identity-before-delete",
        "identity-before-action",
        "shared",
        "pack",
      ].includes(failure)
    )
      expect(mutations(contract.calls)).toHaveLength(0);
    if (failure === "root")
      expect(
        raw().prepare("SELECT count(*) n FROM retry_titles").get(),
      ).toEqual({ n: 0 });
    if (failure.startsWith("blocklist"))
      expect(contract.calls.filter((c) => c.path === "/command")).toHaveLength(
        0,
      );
    if (failure === "search-uncertain") {
      expect(contract.calls.filter((c) => c.path === "/command")).toHaveLength(
        1,
      );
      expect(
        manualRemediationControl(data.mediaId).retryOperationId,
      ).toBeUndefined();
    }
  });
  it("safe pre-mutation retry preserves original evidence and refreshes the old fingerprint", async () => {
    const data = await fixture();
    wire(data, { badHistory: true });
    await fix(data);
    const op = operation(data.identity.fileId);
    const evidence = op.evidence;
    expect(preMutationRetryProof(op)).toBe(true);
    wire(data);
    const retry = await queuePreMutationRetry(
      data.mediaId,
      op.id,
      "fixture-admin",
    );
    await run(retry.id);
    expect(operation(data.identity.fileId)).toMatchObject({
      id: op.id,
      state: "pending",
      evidence,
    });
  });
  it.each([
    "pre-mutation",
    "pending-wrong-language",
    "pending-unknown",
    "uncertain-search",
    "uncertain-blocklist",
  ])("fresh different identity reconciles %s conservatively", async (kind) => {
    const data = await fixture();
    wire(data, {
      badHistory: kind === "pre-mutation",
      failSearch: kind === "uncertain-search",
    });
    await fix(data);
    const op = operation(data.identity.fileId);
    if (kind === "uncertain-blocklist") {
      raw()
        .prepare(
          "DELETE FROM operation_steps WHERE operation_id=? AND step IN ('history-failed','blocklist-verified','replacement-search-intent','replacement-search')",
        )
        .run(op.id);
      raw()
        .prepare("UPDATE operations SET state='needs-attention' WHERE id=?")
        .run(op.id);
    }
    const next = await replacement(
      data,
      kind === "pending-unknown" ? "und" : "spa",
    );
    await verifyReplacement(next.scan, next.identity, next.client);
    if (kind.startsWith("uncertain")) {
      expect(operation(data.identity.fileId).state).toBe("needs-attention");
      expect(() => requireManualAdmission()).toThrow();
    } else {
      expect(operation(data.identity.fileId).state).toBe("superseded");
      expect(operation(data.identity.fileId).evidence).toBe(op.evidence);
      expect(() => requireManualAdmission()).not.toThrow();
      if (kind !== "pending-unknown") {
        expect(manualRemediationControl(next.mediaId)).toMatchObject({
          eligible: true,
          state: "Old attempt superseded — current file can be fixed normally",
        });
        expect(
          queueManualRemediation(next.mediaId, "fixture-admin").id,
        ).toBeTruthy();
      } else
        expect(manualRemediationControl(next.mediaId).eligible).toBe(false);
    }
  });
  it("missing current Arr identity or network uncertainty never supersedes an old attempt", async () => {
    const data = await fixture();
    wire(data, { badHistory: true });
    await fix(data);
    const next = await replacement(data);
    vi.spyOn(next.client as SonarrClient, "findEpisodeFile").mockRejectedValue(
      new Error("Unknown GET outcome"),
    );
    await expect(
      verifyReplacement(next.scan, next.identity, next.client),
    ).rejects.toThrow();
    expect(operation(data.identity.fileId).state).toBe("needs-attention");
  });
  it.each(["monitor", "disabled"])("retains %s safety gate", async (mode) => {
    const data = await fixture();
    const { calls } = wire(data);
    if (mode === "monitor") saveSettings({ safetyMode: "monitor" });
    else process.env.ALLOW_DESTRUCTIVE_ACTIONS = "false";
    expect(() => queueManualRemediation(data.mediaId, "fixture-admin")).toThrow(
      "disabled",
    );
    expect(calls).toHaveLength(0);
  });
  it("needs-analysis rows cannot queue remediation", async () => {
    const data = await fixture();
    raw()
      .prepare("UPDATE media_items SET decision='needs-analysis' WHERE id=?")
      .run(data.mediaId);
    expect(() => queueManualRemediation(data.mediaId, "fixture-admin")).toThrow(
      "conclusive failed",
    );
  });
  it("direct manual calls without an admitted job are refused", async () => {
    const data = await fixture();
    const { client, calls } = wire(data);
    await expect(remediate(data.scan, data.identity, client)).rejects.toThrow(
      "explicitly authorized",
    );
    expect(calls).toHaveLength(0);
  });
  it("backup copy is exclusive and leaves the source intact", async () => {
    const data = await fixture();
    const id = await quarantineModule.preserveRecoveryCopy(
      data.scan,
      new AbortController().signal,
      () => {},
    );
    expect(await readFile(quarantine(id)!.quarantine_path)).toEqual(
      await readFile(data.scan.path),
    );
    await expect(
      quarantineModule.preserveRecoveryCopy(
        data.scan,
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow("already exists");
    const original = await readFile(data.scan.path);
    const backup = quarantine(id)!.quarantine_path;
    const activeStat = await lstat(data.scan.path),
      backupStat = await lstat(backup);
    expect([backupStat.dev, backupStat.ino]).not.toEqual([
      activeStat.dev,
      activeStat.ino,
    ]);
    await writeFile(data.scan.path, "in-place external change");
    expect(await readFile(backup)).toEqual(original);
  });
});

async function readFailure() {
  const data = await fixture();
  wire(data, { badHistory: true });
  await fix(data);
  return { ...data, op: operation(data.identity.fileId) };
}
it.each([
  "backup-copy-intent",
  "backup-copy",
  "arr-delete-intent",
  "arr-delete-verified",
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
  const { calls } = wire({ identity, mediaId, scan });
  expect(manualRemediationControl(mediaId).retryOperationId).toBeUndefined();
  await expect(
    queuePreMutationRetry(mediaId, op.id, "fixture-admin"),
  ).rejects.toThrow("not proven");
  expect(calls).toHaveLength(0);
  expect((await lstat(scan.path)).isFile()).toBe(true);
});
it("persists per-release aliases, title limits, backoff and deliberate reset", () => {
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
it.each(["ignored", "cooldown", "limit"])(
  "does not bypass title %s protection",
  async (guard) => {
    const { scan, identity, mediaId } = await fixture();
    raw()
      .prepare("INSERT INTO retry_titles VALUES(?,?,?,?)")
      .run(
        `${identity.source}:${identity.entityId}`,
        guard === "limit" ? 3 : 0,
        guard === "cooldown" ? Date.now() + 60000 : 0,
        guard === "ignored" ? 1 : 0,
      );
    const { calls } = wire({ scan, identity, mediaId });
    await run(queueManualRemediation(mediaId, "fixture-admin").id!);
    expect(operation(identity.fileId).state).toBe("needs-attention");
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect((await lstat(scan.path)).isFile()).toBe(true);
  },
);
it.each(["disabled", "monitor", "cancelled", "runtime"])(
  "rechecks %s authorization after admission",
  async (gate) => {
    const data = await fixture();
    const { calls } = wire(data);
    const { id } = queueManualRemediation(data.mediaId, "fixture-admin");
    const job = jobQueue.claim()!;
    if (gate === "disabled") process.env.ALLOW_DESTRUCTIVE_ACTIONS = "false";
    if (gate === "monitor") saveSettings({ safetyMode: "monitor" });
    if (gate === "cancelled") jobQueue.cancel(id!);
    if (gate === "runtime")
      vi.spyOn(runtimeModule, "requireRuntimeOwnership").mockImplementation(
        () => {
          throw new Error("Runtime lease lost");
        },
      );
    await executeJob(job, new AbortController().signal);
    expect(mutations(calls)).toHaveLength(0);
    expect(operation(data.identity.fileId)).toBeUndefined();
  },
);
it("requires admin authorization and refuses request-supplied identity/evidence", async () => {
  const data = await fixture();
  const request = (extra = {}) =>
    POST(
      new Request("http://fixture/api/jobs", {
        method: "POST",
        body: JSON.stringify({
          kind: "remediate",
          mediaId: data.mediaId,
          ...extra,
        }),
      }),
    );
  expect(
    (await request({ identity: data.identity, scan: data.scan })).status,
  ).toBe(400);
  vi.mocked(requireAdmin).mockRejectedValueOnce(new Error("Unauthorized"));
  expect((await request()).status).not.toBe(202);
  expect(jobQueue.list()).toHaveLength(0);
});
it("does not automatically loop on later scans of a wrong-language replacement", async () => {
  const data = await fixture();
  wire(data);
  await fix(data);
  const next = await replacement(data, "spa");
  expect(await verifyReplacement(next.scan, next.identity, next.client)).toBe(
    true,
  );
  saveSettings({ safetyMode: "automatic" });
  const request = vi.spyOn(next.client as SonarrClient, "findEpisodeFile");
  expect(await verifyReplacement(next.scan, next.identity, next.client)).toBe(
    true,
  );
  expect(request).not.toHaveBeenCalled();
  expect(raw().prepare("SELECT count(*) n FROM operations").get()).toEqual({
    n: 1,
  });
});
it("recovery backup never attempts a hardlink, even on the same filesystem", async () => {
  const data = await fixture();
  const target = path.join(destination, "independent-copy");
  const linkAttempt = vi.fn(async () => {
    throw new Error("Hardlink forbidden");
  });
  await quarantineModule.moveExclusive(
    data.scan.path,
    target,
    linkAttempt,
    () => {},
    undefined,
    true,
  );
  expect(linkAttempt).not.toHaveBeenCalled();
  expect(await readFile(target)).toEqual(await readFile(data.scan.path));
});
it.each([
  "replacement",
  "identity",
  "backup-symlink",
  "backup-changed",
  "disabled",
])("explicit cleanup refuses unsafe %s", async (kind) => {
  const data = await fixture();
  wire(data);
  await fix(data);
  const op = operation(data.identity.fileId);
  const kept = quarantine(op.quarantine_id!)!;
  const next = await replacement(data);
  await verifyReplacement(next.scan, next.identity, next.client);
  if (kind === "replacement")
    await writeFile(next.scan.path, "changed replacement");
  if (kind === "identity") {
    const contract = wire(next);
    contract.file.id++;
  }
  if (kind === "backup-symlink") {
    await rename(kept.quarantine_path, kept.quarantine_path + ".saved");
    await symlink(kept.quarantine_path + ".saved", kept.quarantine_path);
  }
  if (kind === "backup-changed")
    await writeFile(kept.quarantine_path, "changed backup");
  if (kind === "disabled") process.env.ALLOW_DESTRUCTIVE_ACTIONS = "false";
  await expect(cleanupVerifiedQuarantine(kept.id)).rejects.toThrow();
  expect(quarantine(kept.id)?.state).toBe("quarantined");
  expect(await lstat(kept.quarantine_path)).toBeTruthy();
});

const legacy =
  "Disable Arr automatic failed-download redownload before using Automatic mode";
async function legacyFailure() {
  const data = await readFailure();
  raw()
    .prepare("DELETE FROM operation_steps WHERE operation_id=?")
    .run(data.op.id);
  raw()
    .prepare("UPDATE operations SET error=? WHERE id=?")
    .run(legacy, data.op.id);
  return data;
}
it("exact legacy refusal no longer blocks admission and can retry without erasing evidence", async () => {
  const { identity, mediaId, op } = await legacyFailure();
  const evidence = raw()
    .prepare("SELECT evidence FROM operations WHERE id=?")
    .get(op.id);
  expect(() => requireManualAdmission()).not.toThrow();
  expect(manualRemediationControl(mediaId).retryOperationId).toBe(op.id);
  wire({ identity, mediaId, scan: JSON.parse(op.evidence).scan });
  await run((await queuePreMutationRetry(mediaId, op.id, "fixture-admin")).id);
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
    raw().prepare("UPDATE operations SET release_key='' WHERE id=?").run(op.id);
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
it("supersedes a conclusively resolved unknown DELETE after an external replacement, retaining explicit cleanup", async () => {
  const data = await fixture();
  wire(data, { deleteOutcome: "uncertain" });
  await fix(data);
  const op = operation(data.identity.fileId);
  const backup = quarantine(op.quarantine_id!)!;
  const next = await replacement(data);
  await verifyReplacement(next.scan, next.identity, next.client);
  expect(operation(data.identity.fileId).state).toBe("superseded");
  expect(() => requireManualAdmission()).not.toThrow();
  expect(await lstat(backup.quarantine_path)).toBeTruthy();
  expect(markers(op.id)).toContain("verified-replacement");
  await cleanupVerifiedQuarantine(backup.id);
  await expect(lstat(backup.quarantine_path)).rejects.toMatchObject({
    code: "ENOENT",
  });
});
it("rechecks the retained recovery object before Arr DELETE", async () => {
  const data = await fixture();
  const { calls } = wire(data);
  vi.spyOn(quarantineModule, "verifyRecoveryCopy").mockRejectedValue(
    new Error("Verified recovery copy changed"),
  );
  await fix(data);
  expect(mutations(calls)).toHaveLength(0);
  expect(markers(operation(data.identity.fileId).id)).not.toContain(
    "arr-delete-intent",
  );
});

it.each(["sonarr", "radarr"] as const)(
  "%s import job freshly verifies the replacement and refreshes cached current identity",
  async (source) => {
    const data = await fixture(source);
    wire(data);
    await fix(data);
    const next = await replacement(data);
    raw()
      .prepare("UPDATE media_items SET identity=?,details=? WHERE id=?")
      .run(
        String(data.identity.fileId),
        JSON.stringify(data.identity),
        data.mediaId,
      );
    const queued = jobQueue.enqueue("scan-file", { ...next.identity });
    await run(queued.id);
    expect(operation(data.identity.fileId).state).toBe("complete");
    expect(
      raw()
        .prepare("SELECT identity,decision FROM media_items WHERE id=?")
        .get(data.mediaId),
    ).toEqual({ identity: String(next.identity.fileId), decision: "pass" });
    expect(
      quarantine(operation(data.identity.fileId).quarantine_id!)?.state,
    ).toBe("quarantined");
  },
);

it("a same-size copy with a mismatched SHA-256 readback cannot authorize Arr DELETE", async () => {
  const data = await fixture();
  const { calls } = wire(data);
  const originalOpen = fsPromises.open;
  const synced = vi.fn();
  vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    if (args[1] === "wx+") {
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementationOnce(async () => {
        await handle.write(Buffer.from([255]), 0, 1, 0);
        await sync();
        synced();
      });
    }
    return handle;
  });
  await fix(data);
  expect(synced).toHaveBeenCalledOnce();
  expect(mutations(calls)).toHaveLength(0);
  expect(markers(operation(data.identity.fileId).id)).not.toContain(
    "arr-delete-intent",
  );
  expect((await lstat(data.scan.path)).isFile()).toBe(true);
});
it("source identity is revalidated after backup and before Arr DELETE", async () => {
  const data = await fixture();
  const { calls } = wire(data);
  const verify = quarantineModule.verifyRecoveryCopy;
  vi.spyOn(quarantineModule, "verifyRecoveryCopy").mockImplementationOnce(
    async (id) => {
      await rename(data.scan.path, data.scan.path + ".old");
      await fsPromises.copyFile(data.scan.path + ".old", data.scan.path);
      await verify(id);
    },
  );
  await fix(data);
  expect(mutations(calls)).toHaveLength(0);
  const op = operation(data.identity.fileId);
  expect(markers(op.id)).not.toContain("arr-delete-intent");
  expect(
    await readFile(quarantine(op.quarantine_id!)!.quarantine_path),
  ).toEqual(await readFile(data.scan.path + ".old"));
});

async function legacyFingerprintOperation() {
  const data = await fixture();
  const info = await lstat(data.scan.path),
    settings = getSettings();
  const fingerprintV2 = createHash("sha256")
    .update(
      JSON.stringify([
        data.scan.path,
        info.size,
        info.mtimeMs,
        "",
        [
          settings.requiredLanguages,
          settings.allowDescriptive,
          settings.requireMainProgram,
        ],
        2,
      ]),
    )
    .digest("hex");
  expect(fingerprintV2).not.toBe(data.scan.fingerprint);
  const scan = { ...data.scan, fingerprint: fingerprintV2 };
  saveScan(scan);
  const id = `legacy-fingerprint-${data.identity.fileId}`;
  const releaseKey = `reserved-${id}`;
  reserveReplacement(
    `${data.identity.source}:${data.identity.entityId}`,
    releaseKey,
  );
  raw()
    .prepare(
      `INSERT INTO operations(id,operation_key,source,entity_id,file_id,state,evidence,release_key,error,created_at,updated_at)
    VALUES(?,?,?,?,?,'needs-attention',?,?,?,'legacy','legacy')`,
    )
    .run(
      id,
      id,
      data.identity.source,
      data.identity.entityId,
      data.identity.fileId,
      JSON.stringify({ scan, identity: data.identity }),
      releaseKey,
      "Media or policy changed since scanning",
    );
  for (const step of ["mutation-started", "quarantine-intent"])
    raw()
      .prepare(
        "INSERT INTO operation_steps(operation_id,step,result,created_at) VALUES(?,?,?,?)",
      )
      .run(id, step, "{}", "legacy");
  return { ...data, op: operation(data.identity.fileId) };
}
describe("legacy pre-quarantine fingerprint failure reconciliation", () => {
  it("supersedes the exact reserved v2 failure after a fresh different FAIL without mutations or erasing evidence", async () => {
    const data = await legacyFingerprintOperation();
    expect(() => requireManualAdmission()).toThrow();
    const priorSteps = raw()
      .prepare("SELECT * FROM operation_steps WHERE operation_id=? ORDER BY id")
      .all(data.op.id);
    const reservations = [
      raw().prepare("SELECT * FROM retry_titles").all(),
      raw().prepare("SELECT * FROM retry_releases").all(),
    ];
    const next = await replacement(data, "spa");
    const before = await readFile(next.scan.path),
      stat = await lstat(next.scan.path),
      copies = await readdir(destination);
    const scan = vi.spyOn(scannerModule, "scanFile");
    const client = next.client as SonarrClient;
    const deletes = vi.spyOn(client, "deleteEpisodeFile"),
      blocks = vi.spyOn(client, "markHistoryFailed"),
      searches = vi.spyOn(client, "searchEpisode");
    await verifyReplacement(next.scan, next.identity, client);
    expect(scan).toHaveBeenCalledOnce();
    expect(scan).toHaveBeenCalledWith(
      next.scan.path,
      undefined,
      expect.objectContaining({
        fileId: next.identity.fileId,
        languages: ["Spanish"],
      }),
    );
    expect(operation(data.identity.fileId)).toMatchObject({
      ...data.op,
      state: "superseded",
      updated_at: expect.any(String),
    });
    expect(
      raw()
        .prepare(
          "SELECT * FROM operation_steps WHERE operation_id=? ORDER BY id",
        )
        .all(data.op.id)
        .slice(0, 2),
    ).toEqual(priorSteps);
    expect(
      JSON.parse(
        (
          raw()
            .prepare(
              "SELECT result FROM operation_steps WHERE operation_id=? AND step='superseded'",
            )
            .get(data.op.id) as { result: string }
        ).result,
      ).reason,
    ).toBe(
      "Legacy pre-quarantine fingerprint validation failure; media subsequently changed outside Media Guard",
    );
    expect([
      raw().prepare("SELECT * FROM retry_titles").all(),
      raw().prepare("SELECT * FROM retry_releases").all(),
    ]).toEqual(reservations);
    expect(() => requireManualAdmission()).not.toThrow();
    expect(manualRemediationControl(next.mediaId)).toMatchObject({
      eligible: true,
      retryOperationId: undefined,
    });
    await expect(
      queuePreMutationRetry(next.mediaId, data.op.id, "fixture-admin"),
    ).rejects.toThrow();
    expect(deletes).not.toHaveBeenCalled();
    expect(blocks).not.toHaveBeenCalled();
    expect(searches).not.toHaveBeenCalled();
    expect(await readFile(next.scan.path)).toEqual(before);
    expect(await lstat(next.scan.path)).toMatchObject({
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
    expect(await readdir(destination)).toEqual(copies);
    expect(raw().prepare("SELECT count(*) n FROM quarantines").get()).toEqual({
      n: 0,
    });
  });
  it.each([
    "same-file",
    "old-file-present",
    "quarantine-path",
    "quarantine-fingerprint",
    "quarantine-operation",
    "quarantine-id",
    "different-error",
    "wrong-state",
    "quarantine",
    "backup-copy-intent",
    "backup-copy",
    "arr-delete-intent",
    "arr-delete-verified",
    "rescan-command-intent",
    "rescan-command",
    "history-failed-intent",
    "history-failed",
    "blocklist-verified",
    "replacement-search-intent",
    "replacement-search",
    "cleanup-intent",
    "cleanup-complete",
    "unknown-step",
    "missing-step",
    "missing-quarantine-intent",
    "duplicate-step",
    "uncertain-read",
    "invalid-current-identity",
  ])("remains blocked for %s", async (blocker) => {
    const data = await legacyFingerprintOperation();
    if (blocker.startsWith("quarantine-") && blocker !== "quarantine-id") {
      const oldScan = JSON.parse(data.op.evidence).scan;
      raw()
        .prepare("INSERT INTO quarantines VALUES(?,?,?,?,?,?,?)")
        .run(
          `copy-${data.op.id}`,
          blocker === "quarantine-path" ? oldScan.path : "/unrelated",
          "/unused",
          JSON.stringify(
            blocker === "quarantine-fingerprint"
              ? { scan: { fingerprint: oldScan.fingerprint } }
              : blocker === "quarantine-operation"
                ? { operationId: data.op.id }
                : {},
          ),
          "needs-attention",
          "legacy",
          null,
        );
    } else if (blocker === "quarantine-id")
      raw()
        .prepare("UPDATE operations SET quarantine_id='copy' WHERE id=?")
        .run(data.op.id);
    else if (blocker === "different-error")
      raw()
        .prepare("UPDATE operations SET error=error || '.' WHERE id=?")
        .run(data.op.id);
    else if (blocker === "wrong-state")
      raw()
        .prepare("UPDATE operations SET state='pending' WHERE id=?")
        .run(data.op.id);
    else if (blocker === "missing-quarantine-intent")
      raw()
        .prepare(
          "DELETE FROM operation_steps WHERE operation_id=? AND step='quarantine-intent'",
        )
        .run(data.op.id);
    else if (blocker === "missing-step")
      raw()
        .prepare(
          "DELETE FROM operation_steps WHERE operation_id=? AND step='mutation-started'",
        )
        .run(data.op.id);
    else if (
      ![
        "same-file",
        "old-file-present",
        "uncertain-read",
        "invalid-current-identity",
      ].includes(blocker)
    )
      raw()
        .prepare(
          "INSERT INTO operation_steps(operation_id,step,result,created_at) VALUES(?,?,?,?)",
        )
        .run(
          data.op.id,
          blocker === "duplicate-step" ? "quarantine-intent" : blocker,
          "{}",
          "legacy",
        );
    const unchanged = operation(data.identity.fileId);
    if (blocker === "same-file") {
      const { client } = wire(data);
      await verifyReplacement(data.scan, data.identity, client);
    } else {
      const next = await replacement(data, "spa"),
        client = next.client as SonarrClient;
      const read = client.findEpisodeFile.bind(client);
      vi.spyOn(client, "findEpisodeFile").mockImplementation(async (id) => {
        if (id === data.identity.fileId && blocker === "old-file-present")
          return {
            id,
            path: data.identity.arrPath,
            seriesId: data.identity.seriesId,
          };
        if (id === data.identity.fileId && blocker === "uncertain-read")
          throw new Error("Unknown Arr read outcome");
        if (
          id === next.identity.fileId &&
          blocker === "invalid-current-identity"
        )
          return undefined;
        return read(id);
      });
      const pending = verifyReplacement(next.scan, next.identity, client);
      if (["uncertain-read", "invalid-current-identity"].includes(blocker))
        await expect(pending).rejects.toThrow();
      else await pending;
    }
    expect(operation(data.identity.fileId)).toEqual(unchanged);
    expect(markers(data.op.id)).not.toContain("superseded");
    expect(() => requireManualAdmission()).toThrow();
  });
});
