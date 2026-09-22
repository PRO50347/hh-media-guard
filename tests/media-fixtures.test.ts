import { beforeAll, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "../src/lib/process";
import { scanFile } from "../src/lib/scanner";
import { addMapping, jobQueue, listScans, raw } from "../src/lib/store";
import { executeJob } from "../src/lib/worker";
import { WorkerRunner } from "../src/lib/worker-runner";

const root = join(process.env.CONFIG_DIR!, "generated-media");
beforeAll(async () => {
  await mkdir(root);
  for (const language of ["eng", "spa", "fra", "und"]) {
    await runProcess("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2",
      "-c:a",
      "aac",
      "-metadata:s:a:0",
      `language=${language}`,
      join(root, `${language}.mka`),
    ]);
  }
  await runProcess("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=duration=2",
    "-f",
    "lavfi",
    "-i",
    "sine=duration=2",
    "-map",
    "0:a",
    "-map",
    "1:a",
    "-c:a",
    "aac",
    "-metadata:s:a:0",
    "language=spa",
    "-metadata:s:a:1",
    "language=eng",
    "-metadata:s:a:1",
    "title=Director commentary",
    join(root, "commentary.mka"),
  ]);
  addMapping({
    source: "generic",
    arrPath: "/data",
    containerPath: root,
    mediaType: "other",
    enabled: true,
  });
});
describe("generated FFmpeg media and durable scans", () => {
  it.each([
    ["eng", "pass"],
    ["spa", "fail"],
    ["fra", "fail"],
    ["und", "needs-analysis"],
    ["commentary", "fail"],
  ])("inspects %s fixture", async (name, decision) => {
    expect((await scanFile(join(root, `${name}.mka`))).decision).toBe(decision);
  });
  it("persists a queued scan and skips an unchanged file", async () => {
    const file = join(root, "eng.mka");
    const job = jobQueue.enqueue("scan-file", { path: file });
    const runner = new WorkerRunner(jobQueue, executeJob);
    await runner.tick();
    expect(jobQueue.get(job.id)?.state).toBe("completed");
    const before = listScans().find((scan) => scan.path === file)!;
    jobQueue.enqueue("scan-file", { path: file });
    await runner.tick();
    expect(listScans().find((scan) => scan.path === file)?.scannedAt).toBe(
      before.scannedAt,
    );
    await runner.stop();
  });
  it("routes unmapped imported paths to Needs Attention", async () => {
    const job = jobQueue.enqueue("scan-file", {
      arrPath: "/unmapped/file.mkv",
      source: "sonarr",
    });
    const runner = new WorkerRunner(jobQueue, executeJob);
    await runner.tick();
    expect(jobQueue.get(job.id)?.state).toBe("needs-attention");
    expect(
      raw().prepare("SELECT reason FROM attention WHERE subject=?").get(job.id),
    ).toEqual({ reason: "unmapped path" });
    await runner.stop();
  });
  it("fails malformed media safely", async () => {
    const file = join(root, "malformed.mkv");
    await writeFile(file, "not media");
    await expect(scanFile(file)).rejects.toThrow("inspection failed");
  });
});
