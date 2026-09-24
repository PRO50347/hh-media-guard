import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ languages: [{ id: 1, name: "English" }] }));
vi.mock("../src/lib/clients", () => ({
  RadarrClient: class {
    async testConnection() {
      return { appName: "Radarr", version: "5.0.0.0" };
    }
    async movies() {
      return [{ id: 1, title: "Fixture", hasFile: true }];
    }
    async movieFiles() {
      return [
        {
          id: 10,
          movieId: 1,
          path: "/arr/file.mkv",
          languages: state.languages,
        },
      ];
    }
  },
  SonarrClient: class {},
}));
import { executeJob } from "../src/lib/worker";
import {
  saveIntegration,
  jobQueue,
  raw,
  needsAttention,
  listScans,
} from "../src/lib/store";
import { encryptSecret } from "../src/lib/crypto";
import { runProcess } from "../src/lib/process";
it("uses fresh exact-file evidence for cache reuse and resolves only obsolete unknown-language attention", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mg-worker-fallback-"));
  const previous = process.env.MEDIA_ROOTS;
  process.env.MEDIA_ROOTS = dir;
  try {
    await runProcess("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=stereo",
      "-t",
      "1",
      "-c:a",
      "ac3",
      "-metadata:s:a:0",
      "language=und",
      "-disposition:a:0",
      "default",
      path.join(dir, "file.mkv"),
    ]);
    saveIntegration(
      "radarr",
      true,
      "http://fixture.test",
      encryptSecret("isolated-key"),
    );
    raw()
      .prepare("INSERT INTO mappings VALUES(?,?,?,?,?,?)")
      .run("fixture", "radarr", "/arr", dir, "movies", 1);
    const subject = `radarr:1:${path.join(dir, "file.mkv")}`;
    needsAttention(subject, "unknown language", {});
    async function scan() {
      const queued = jobQueue.enqueue("scan-library", { source: "radarr" });
      const job = jobQueue.claim()!;
      await executeJob(job, new AbortController().signal);
      jobQueue.finish(job, "completed");
      expect(job.id).toBe(queued.id);
      return listScans()[0];
    }
    expect((await scan()).decision).toBe("pass");
    expect(
      raw().prepare("SELECT state FROM attention WHERE subject=?").get(subject),
    ).toEqual({ state: "resolved" });
    state.languages = [];
    expect((await scan()).decision).toBe("needs-analysis");
    expect(
      raw().prepare("SELECT state FROM attention WHERE subject=?").get(subject),
    ).toEqual({ state: "open" });
    needsAttention(subject, "quarantine failure", {});
    state.languages = [{ id: 1, name: "English" }];
    expect((await scan()).decision).toBe("pass");
    expect(
      raw()
        .prepare("SELECT state,reason FROM attention WHERE subject=?")
        .get(subject),
    ).toEqual({ state: "open", reason: "quarantine failure" });
  } finally {
    if (previous === undefined) delete process.env.MEDIA_ROOTS;
    else process.env.MEDIA_ROOTS = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
