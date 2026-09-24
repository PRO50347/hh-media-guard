import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as processRunner from "../src/lib/process";
import { InspectionError } from "../src/lib/process";
import { parseProbe } from "../src/lib/scanner";
import { executeJob } from "../src/lib/worker";
import { raw, jobQueue } from "../src/lib/store";

it("retains bounded process diagnostics without raw stderr or environment secrets", async () => {
  const error = await processRunner
    .runProcess(process.execPath, [
      "-e",
      "process.stderr.write('Input/output error '+process.env.ENCRYPTION_KEY+'x'.repeat(10000));process.exitCode=7;",
    ])
    .catch((e) => e);
  expect(error).toBeInstanceOf(InspectionError);
  expect(error.diagnostics).toMatchObject({
    stage: "process",
    category: "exit",
    exitCode: 7,
    signal: null,
    stderrTruncated: true,
    stderrSummary: "input/output error",
  });
  expect(error.diagnostics.stderrBytes).toBeGreaterThan(10000);
  expect(JSON.stringify(error)).not.toContain(process.env.ENCRYPTION_KEY!);
  expect(JSON.stringify(error).length).toBeLessThan(600);
});
it("preserves timeout, signal and missing-executable categories", async () => {
  const timeout = await processRunner
    .runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      timeoutMs: 40,
    })
    .catch((e) => e);
  expect(timeout.diagnostics).toMatchObject({
    stage: "process",
    category: "timeout",
    signal: "SIGKILL",
  });
  const missing = await processRunner
    .runProcess("/nonexistent-private-fixture", [])
    .catch((e) => e);
  expect(missing.diagnostics).toMatchObject({
    category: "spawn",
    systemCode: "ENOENT",
  });
  expect(missing.retryable).toBe(false);
  expect(JSON.stringify(missing)).not.toContain("private-fixture");
});
it("distinguishes parse failures without storing the malformed output", () => {
  try {
    parseProbe("secret-json");
    throw new Error("expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(InspectionError);
    expect((error as InspectionError).diagnostics).toEqual({
      stage: "parse",
      category: "invalid-json-or-schema",
      stdoutBytes: 11,
    });
    expect(JSON.stringify(error)).not.toContain("secret-json");
  }
});
it.each([false, true])(
  "worker retries once; repeated failure=%s preserves evidence without a successful scan",
  async (repeated) => {
    const dir = await mkdtemp(path.join(tmpdir(), "mg-probe-test-"));
    const file = path.join(dir, "fixture.mkv");
    await writeFile(file, "fixture with mocked ffprobe");
    raw()
      .prepare("INSERT INTO mappings VALUES(?,?,?,?,?,?)")
      .run(dir, "generic", dir, dir, "movies", 1);
    const failure = () =>
      new InspectionError(
        "Media inspection failed; verify the file is readable and valid",
        {
          stage: "process",
          category: "exit",
          exitCode: 1,
          stdoutBytes: 0,
          stderrBytes: 18,
          stderrSummary: "input/output error",
        },
        true,
      );
    const mock = vi
      .spyOn(processRunner, "runProcess")
      .mockRejectedValueOnce(failure());
    if (repeated) mock.mockRejectedValueOnce(failure());
    else
      mock.mockResolvedValueOnce(
        JSON.stringify({
          format: { duration: "6327" },
          streams: [
            {
              index: 0,
              codec_type: "audio",
              codec_name: "aac",
              tags: { language: "eng" },
              disposition: { default: 1 },
            },
          ],
        }),
      );
    const queued = jobQueue.enqueue("scan-file", { path: file });
    const job = jobQueue.claim()!;
    expect(job.id).toBe(queued.id);
    try {
      const execution = executeJob(job, new AbortController().signal);
      if (repeated) {
        await expect(execution).rejects.toBeInstanceOf(InspectionError);
        expect(
          raw().prepare("SELECT COUNT(*) n FROM scans WHERE path=?").get(file),
        ).toEqual({ n: 0 });
        const row = raw()
          .prepare("SELECT evidence FROM attention WHERE subject=?")
          .get(file) as { evidence: string };
        expect(JSON.parse(row.evidence).diagnostics).toMatchObject({
          stage: "process",
          exitCode: 1,
          stderrSummary: "input/output error",
        });
      } else {
        await execution;
        expect(
          raw().prepare("SELECT decision FROM scans WHERE path=?").get(file),
        ).toEqual({ decision: "pass" });
        expect(
          raw()
            .prepare("SELECT COUNT(*) n FROM attention WHERE subject=?")
            .get(file),
        ).toEqual({ n: 0 });
      }
      expect(mock).toHaveBeenCalledTimes(2);
    } finally {
      mock.mockRestore();
      jobQueue.finish(job, "completed");
      raw().prepare("DELETE FROM mappings WHERE id=?").run(dir);
      await rm(dir, { recursive: true, force: true });
    }
  },
);
