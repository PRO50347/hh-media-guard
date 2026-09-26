import { afterAll, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as scanner from "../src/lib/scanner";
import * as transport from "../src/lib/arr-transport";
import {
  addMapping,
  getSettings,
  saveSettings,
  saveIntegration,
  saveScan,
  upsertMediaItem,
  raw,
  jobQueue,
} from "../src/lib/store";
import { encryptSecret } from "../src/lib/crypto";
import { executeJob } from "../src/lib/worker";
import { maintenance } from "../src/lib/maintenance";
import { receiveWebhook, rotateWebhookToken } from "../src/lib/webhooks";
import { POST } from "../src/app/api/jobs/route";
import type { ScanResult } from "../src/lib/types";
import { mediaPage } from "../src/lib/media-page";
vi.mock("../src/lib/auth", () => ({
  requireAdmin: vi.fn(async () => ({ username: "fixture" })),
}));
let root = "";
afterAll(async () => {
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
});

it("100 failures: audits, schedules, webhooks and rescan actions cannot remediate; one explicit click admits exactly one job", async () => {
  root = await mkdtemp(path.join(tmpdir(), "hh-manual-mode-"));
  const media = path.join(root, "media");
  const quarantine = path.join(root, "quarantine");
  await mkdir(media);
  await mkdir(quarantine);
  process.env.ALLOW_DESTRUCTIVE_ACTIONS = "true";
  saveSettings({
    safetyMode: "manual",
    quarantinePath: quarantine,
    scanIntervalHours: 1,
  });
  addMapping({
    source: "radarr",
    arrPath: "/movies",
    containerPath: media,
    mediaType: "movies",
    enabled: true,
  });
  saveIntegration(
    "radarr",
    true,
    "http://fixture.test",
    encryptSecret("fixture-key"),
  );
  const files = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    movieId: index + 1,
    path: `/movies/${index + 1}.mkv`,
    languages: [{ id: 3, name: "Spanish" }],
  }));
  const movies = files.map((file) => ({
    id: file.movieId,
    title: `Movie ${String(file.id).padStart(3, "0")}`,
    hasFile: true,
    movieFile: file,
  }));
  const scans = new Map<string, ScanResult>();
  for (const file of files) {
    const local = path.join(media, `${file.id}.mkv`);
    await writeFile(local, `unchanged fixture ${file.id}`);
    const scan: ScanResult = {
      path: local,
      duration: 600,
      decision: "fail",
      reason: "Known non-English",
      scannedAt: new Date().toISOString(),
      fingerprint: await scanner.fingerprint(local, getSettings()),
      tracks: [
        {
          index: 0,
          codec: "aac",
          language: "spa",
          rawLanguage: "spa",
          isDefault: true,
          isCommentary: false,
          isDescriptive: false,
        },
      ],
    };
    scans.set(local, scan);
    saveScan(scan);
    upsertMediaItem({
      source: "radarr",
      arrId: file.id,
      title: movies[file.id - 1].title,
      path: local,
      identity: String(file.id),
    });
    raw()
      .prepare(
        "UPDATE media_items SET fingerprint=?,decision='fail',details=? WHERE arr_id=?",
      )
      .run(
        scan.fingerprint,
        JSON.stringify({
          source: "radarr",
          entityId: file.id,
          fileId: file.id,
          arrPath: file.path,
        }),
        file.id,
      );
  }
  const inspect = vi
    .spyOn(scanner, "scanFile")
    .mockImplementation(async (file, _signal, evidence) => ({
      ...scans.get(file)!,
      arrFileEvidence: evidence,
    }));
  const requests = vi
    .spyOn(transport, "arrTransport")
    .mockImplementation(async (url, _key, method) => {
      expect(method).toBe("GET");
      const endpoint = url.pathname.replace("/api/v3", "");
      if (endpoint === "/system/status")
        return { appName: "Radarr", version: "6.4.4.10685" };
      if (endpoint === "/movie") return movies;
      if (endpoint.startsWith("/movie/"))
        return movies[Number(endpoint.split("/").pop()) - 1];
      throw new Error(`Unexpected scan request: ${endpoint}`);
    });
  const queue = (body: object) =>
    POST(
      new Request("http://fixture/api/jobs", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
  async function drainScans() {
    for (;;) {
      const job = jobQueue.claim();
      if (!job) break;
      expect(job.kind).not.toBe("remediate");
      await executeJob(job, new AbortController().signal);
      expect(jobQueue.get(job.id)?.state).not.toBe("needs-attention");
      jobQueue.finish(job, "completed");
    }
    expect(
      raw().prepare("SELECT COUNT(*) n FROM jobs WHERE kind='remediate'").get(),
    ).toEqual({ n: 0 });
    expect(raw().prepare("SELECT COUNT(*) n FROM operations").get()).toEqual({
      n: 0,
    });
    expect(raw().prepare("SELECT COUNT(*) n FROM quarantines").get()).toEqual({
      n: 0,
    });
    expect(await readdir(media)).toHaveLength(100);
    expect(await readdir(quarantine)).toHaveLength(0);
  }
  expect(
    (await queue({ kind: "scan-library", source: "radarr", force: true }))
      .status,
  ).toBe(202);
  await drainScans();
  expect(inspect).toHaveBeenCalledTimes(100);
  maintenance();
  await drainScans();
  const token = rotateWebhookToken("radarr");
  const response = await receiveWebhook(
    "radarr",
    new Request("http://fixture/webhook", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        eventType: "Download",
        movie: { id: 1 },
        movieFile: { id: 1, path: files[0].path },
        downloadId: "fixture-download",
      }),
    }),
  );
  expect(response.status).toBe(202);
  await drainScans();
  expect(
    (
      await queue({
        kind: "scan-library",
        source: "radarr",
        entityId: 1,
        force: true,
      })
    ).status,
  ).toBe(202);
  await drainScans();
  expect(
    (
      await queue({
        kind: "scan-file",
        path: scans.keys().next().value,
        force: true,
      })
    ).status,
  ).toBe(202);
  await drainScans();
  const page = mediaPage(
    new URLSearchParams({ status: "fail", page: "2" }),
    "radarr",
  );
  expect(page.items).toHaveLength(25);
  // The current-page payloads emitted by MediaView's displayed-media action.
  for (const row of page.items)
    expect(
      (
        await queue({
          kind: "scan-library",
          source: "radarr",
          entityId: row.arr_id,
          force: true,
        })
      ).status,
    ).toBe(202);
  await drainScans();
  expect(inspect.mock.calls.length).toBeGreaterThanOrEqual(127);
  const before = raw().prepare("SELECT * FROM media_items ORDER BY id").all();
  const first = (await (
    await queue({ kind: "remediate", mediaId: page.items[0].id })
  ).json()) as { id: string };
  expect(first.id).toBeTruthy();
  expect(
    (await queue({ kind: "remediate", mediaId: page.items[1].id })).status,
  ).toBe(400);
  expect(
    (
      await (
        await queue({ kind: "remediate", mediaId: page.items[0].id })
      ).json()
    ).id,
  ).toBe(first.id);
  const job = jobQueue.claim()!;
  expect(job.id).toBe(first.id);
  expect(
    (await queue({ kind: "remediate", mediaId: page.items[1].id })).status,
  ).toBe(400);
  expect(
    raw().prepare("SELECT COUNT(*) n FROM jobs WHERE kind='remediate'").get(),
  ).toEqual({ n: 1 });
  expect(raw().prepare("SELECT * FROM media_items ORDER BY id").all()).toEqual(
    before,
  );
  expect(requests.mock.calls.every((call) => call[2] === "GET")).toBe(true);
  expect(await readdir(media)).toHaveLength(100);
});
