import { beforeAll, afterAll, afterEach, describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RadarrClient, SonarrClient } from "../src/lib/clients";
import type { ArrTransport } from "../src/lib/arr-transport";
import {
  remediate,
  verifyReplacement,
  type MediaIdentity,
} from "../src/lib/remediation";
import { reserveReplacement, resetReplacement } from "../src/lib/retries";
import { addMapping, saveSettings, saveScan, raw } from "../src/lib/store";
import { scanFile } from "../src/lib/scanner";
import { runProcess } from "../src/lib/process";
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
  process.env.ALLOW_DESTRUCTIVE_ACTIONS = "false";
  saveSettings({ safetyMode: "monitor" });
});
async function fixture(source: "sonarr" | "radarr" = "radarr") {
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
    "language=spa",
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
  return { scan, identity };
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
    ambiguous?: boolean;
    wrongFile?: boolean;
    wrongCommand?: boolean;
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
    if (endpoint === "/history/failed/2") return {};
    throw new Error(`Unexpected mock endpoint ${endpoint}`);
  };
  const client =
    identity.source === "sonarr"
      ? new SonarrClient("http://sonarr-fixture.test", "test-key", transport)
      : new RadarrClient("http://radarr-fixture.test", "test-key", transport);
  return { client, calls };
}
const operation = (fileId: number) =>
  raw().prepare("SELECT * FROM operations WHERE file_id=?").get(fileId) as {
    id: string;
    state: string;
    error?: string;
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
