import { beforeAll, afterAll, afterEach, describe, it, expect } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  lstat,
  symlink,
  link,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  moveExclusive,
  moveToQuarantine,
  restoreFromQuarantine,
} from "../src/lib/quarantine";
import {
  addMapping,
  saveSettings,
  saveScan,
  quarantine,
} from "../src/lib/store";
import { scanFile } from "../src/lib/scanner";
import { runProcess } from "../src/lib/process";
let root: string;
let media: string;
let destination: string;
let sequence = 0;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "media-guard-quarantine-"));
  media = path.join(root, "media");
  destination = path.join(root, "quarantine");
  await mkdir(media);
  await mkdir(destination);
  addMapping({
    source: "generic",
    arrPath: "/fixtures",
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
async function fixture(language = "spa") {
  const file = path.join(media, `sample-${sequence++}.mka`);
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
  return scan;
}
function enable() {
  process.env.ALLOW_DESTRUCTIVE_ACTIONS = "true";
  saveSettings({ safetyMode: "quarantine", quarantinePath: destination });
}
describe("durable quarantine and restore", () => {
  it("refuses a source replaced after evidence validation", async () => {
    const source = path.join(media, "replaced-source");
    const target = path.join(destination, "replaced-target");
    await writeFile(source, "original");
    const identity = await lstat(source);
    await rename(source, path.join(media, "saved-original"));
    await writeFile(source, "replacement");
    await expect(
      moveExclusive(source, target, undefined, undefined, identity),
    ).rejects.toThrow("Source changed");
    expect(await readFile(source, "utf8")).toBe("replacement");
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("never moves evidence for an already cancelled job", async () => {
    const scan = await fixture();
    enable();
    const controller = new AbortController();
    controller.abort(new Error("Job cancelled"));
    await expect(moveToQuarantine(scan, controller.signal)).rejects.toThrow(
      "Job cancelled",
    );
    expect((await lstat(scan.path)).isFile()).toBe(true);
  });
  it("retains the original if the created hardlink has the wrong identity", async () => {
    const source = path.join(media, "identity-source");
    const target = path.join(destination, "identity-target");
    await writeFile(source, "original");
    await expect(
      moveExclusive(source, target, async (_source, targetPath) => {
        await writeFile(targetPath, "imposter");
      }),
    ).rejects.toThrow("identity mismatch");
    expect(await readFile(source, "utf8")).toBe("original");
  });
  it("pins source parents so a symlink swap cannot redirect removal", async () => {
    const parent = path.join(media, "pinned-parent");
    const renamed = path.join(media, "renamed-parent");
    const unrelated = path.join(media, "unrelated-parent");
    await mkdir(parent);
    await mkdir(unrelated);
    await writeFile(path.join(parent, "file"), "original");
    await writeFile(path.join(unrelated, "file"), "unrelated");
    const target = path.join(destination, "pinned-target");
    await moveExclusive(
      path.join(parent, "file"),
      target,
      async (sourcePath, targetPath) => {
        await rename(parent, renamed);
        await symlink(unrelated, parent);
        await link(sourcePath, targetPath);
      },
    );
    expect(await readFile(path.join(unrelated, "file"), "utf8")).toBe(
      "unrelated",
    );
    expect(await readFile(target, "utf8")).toBe("original");
    await expect(lstat(path.join(renamed, "file"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("retains both copies when authorization is revoked before unlink", async () => {
    const source = path.join(media, "revoked-source");
    const target = path.join(destination, "revoked-target");
    await writeFile(source, "original");
    await expect(
      moveExclusive(source, target, undefined, () => {
        throw new Error("Runtime lease lost");
      }),
    ).rejects.toThrow("lease lost");
    expect(await readFile(source, "utf8")).toBe("original");
    expect(await readFile(target, "utf8")).toBe("original");
  });
  it("Monitor Only never moves a failed file", async () => {
    const scan = await fixture();
    await expect(moveToQuarantine(scan)).rejects.toThrow("Explicit");
    expect((await lstat(scan.path)).isFile()).toBe(true);
  });
  it("requires both the explicit mode and environment switch", async () => {
    const scan = await fixture();
    saveSettings({ safetyMode: "quarantine", quarantinePath: destination });
    await expect(moveToQuarantine(scan)).rejects.toThrow("Explicit");
    process.env.ALLOW_DESTRUCTIVE_ACTIONS = "true";
    saveSettings({ safetyMode: "monitor" });
    await expect(moveToQuarantine(scan)).rejects.toThrow("Explicit");
  });
  it("quarantines and restores a generated foreign-language fixture", async () => {
    const scan = await fixture();
    enable();
    const bytes = await readFile(scan.path);
    const id = await moveToQuarantine(scan);
    expect(quarantine(id)?.state).toBe("quarantined");
    await expect(lstat(scan.path)).rejects.toMatchObject({ code: "ENOENT" });
    await restoreFromQuarantine(id);
    expect(await readFile(scan.path)).toEqual(bytes);
    expect(quarantine(id)?.state).toBe("restored");
    await expect(restoreFromQuarantine(id)).rejects.toThrow("Active");
  });
  it("retained identity metadata does not allow the same evidence to be quarantined twice", async () => {
    const scan = await fixture();
    enable();
    const id = await moveToQuarantine(scan);
    await restoreFromQuarantine(id);
    await expect(moveToQuarantine(scan)).rejects.toThrow("already exists");
    expect((await lstat(scan.path)).isFile()).toBe(true);
  });
  it("refuses changed media since evidence was captured", async () => {
    const scan = await fixture();
    enable();
    await writeFile(scan.path, "changed");
    await expect(moveToQuarantine(scan)).rejects.toThrow("changed");
    expect(await readFile(scan.path, "utf8")).toBe("changed");
  });
  it("never quarantines passing or unknown evidence", async () => {
    const scan = await fixture("eng");
    enable();
    await expect(moveToQuarantine(scan)).rejects.toThrow("conclusive");
    await expect(
      moveToQuarantine({ ...scan, decision: "needs-analysis" }),
    ).rejects.toThrow("conclusive");
  });
  it("never overwrites a replacement during restore", async () => {
    const scan = await fixture();
    enable();
    const id = await moveToQuarantine(scan);
    await writeFile(scan.path, "new replacement");
    await expect(restoreFromQuarantine(id)).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await readFile(scan.path, "utf8")).toBe("new replacement");
    expect((await lstat(quarantine(id)!.quarantine_path)).isFile()).toBe(true);
    expect(quarantine(id)?.state).toBe("needs-attention");
  });
  it("rejects a quarantine symlink", async () => {
    const scan = await fixture();
    enable();
    const alias = path.join(root, "alias");
    await symlink(destination, alias);
    saveSettings({ quarantinePath: alias });
    await expect(moveToQuarantine(scan)).rejects.toThrow("non-symlink");
  });
  it("copies across filesystems with exclusive creation before removing source", async () => {
    const source = path.join(media, "cross-source");
    const target = path.join(destination, "cross-target");
    await writeFile(source, "fixture");
    await moveExclusive(source, target, async () => {
      throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
    });
    expect(await readFile(target, "utf8")).toBe("fixture");
    await expect(lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("retains original and existing target on cross-filesystem failure", async () => {
    const source = path.join(media, "failed-source");
    const target = path.join(destination, "existing-target");
    await writeFile(source, "original");
    await writeFile(target, "existing");
    await expect(
      moveExclusive(source, target, async () => {
        throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(source, "utf8")).toBe("original");
    expect(await readFile(target, "utf8")).toBe("existing");
  });
});
