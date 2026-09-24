import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { runProcess } from "../src/lib/process";
import { scanFile, fingerprint } from "../src/lib/scanner";
import { defaults } from "../src/lib/types";
it("inspects generated Rugrats-style stereo AC3 with actual ffprobe and exact file classification", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mg-und-fixture-"));
  try {
    const file = path.join(dir, "Rugrats - S01E04 - At The Movies.mkv");
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
      "-b:a",
      "192k",
      "-metadata:s:a:0",
      "language=und",
      "-metadata:s:a:0",
      "title=Stereo",
      "-disposition:a:0",
      "default",
      file,
    ]);
    const original = await scanFile(file);
    expect(original.decision).toBe("needs-analysis");
    for (const source of ["sonarr", "radarr"] as const) {
      const resolved = await scanFile(file, undefined, {
        source,
        entityId: 4,
        fileId: 10,
        arrPath: file,
        languages: ["English"],
      });
      expect(resolved).toMatchObject({
        decision: "pass",
        languageEvidence: { source },
      });
      expect(resolved.tracks[0]).toMatchObject({
        codec: "ac3",
        language: "und",
        isDefault: true,
        channels: 2,
        isCommentary: false,
        isDescriptive: false,
      });
      expect(resolved.fingerprint).toBe(await fingerprint(file, defaults()));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
