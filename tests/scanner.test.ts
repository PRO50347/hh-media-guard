import { describe, expect, it } from "vitest";
import { parseProbe } from "../src/lib/scanner";
import { runProcess } from "../src/lib/process";

describe("bounded media inspection", () => {
  it("rejects malformed ffprobe JSON", () =>
    expect(() => parseProbe("{bad")).toThrow("malformed"));
  it("rejects invalid stream structure", () =>
    expect(() => parseProbe('{"streams":{}}')).toThrow("malformed"));
  it("rejects excessive stream counts", () =>
    expect(() =>
      parseProbe(
        JSON.stringify({
          streams: Array.from({ length: 257 }, () => ({
            index: 0,
            codec_type: "audio",
          })),
        }),
      ),
    ).toThrow());
  it("times out a hung process", async () => {
    await expect(
      runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        timeoutMs: 30,
      }),
    ).rejects.toThrow("timed out");
  });
  it("caps metadata output", async () => {
    await expect(
      runProcess(
        process.execPath,
        ["-e", 'process.stdout.write("x".repeat(10000))'],
        { maxBytes: 10 },
      ),
    ).rejects.toThrow("size limit");
  });
  it("redacts untrusted stderr", async () => {
    await expect(
      runProcess(process.execPath, [
        "-e",
        'console.error("private key"); process.exit(2)',
      ]),
    ).rejects.toThrow("verify the file");
  });
  it("handles unavailable executables", async () => {
    await expect(
      runProcess("/nonexistent-media-guard-executable", []),
    ).rejects.toThrow("unavailable");
  });
  it("cancels running inspection", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(
      runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        signal: abort.signal,
      }),
    ).rejects.toThrow("cancelled");
  });
  it("passes special filenames literally", async () => {
    const filename = "/tmp/日本語 spaces $(echo injected);.mkv";
    expect(
      await runProcess(process.execPath, [
        "-e",
        "process.stdout.write(process.argv[1])",
        filename,
      ]),
    ).toBe(filename);
  });
});
