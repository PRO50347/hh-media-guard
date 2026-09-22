import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeMediaPath, validateMappingRoot } from "../src/lib/security";
let directory: string;
let root: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "mg-paths-"));
  root = join(directory, "media");
  await mkdir(root);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
describe("filesystem boundaries", () => {
  it("accepts Unicode and special filenames without interpretation", async () => {
    const file = join(root, "日本語 $(x); file.mkv");
    await writeFile(file, "fixture");
    expect(await safeMediaPath(file, [root])).toBe(file);
  });
  it("rejects traversal even if normalized output falls inside the root", async () => {
    await expect(safeMediaPath(`${root}/../media/a`, [root])).rejects.toThrow(
      "traversal",
    );
  });
  it("rejects a file symlink escape", async () => {
    const outside = join(directory, "secret");
    await writeFile(outside, "fixture");
    await symlink(outside, join(root, "escape"));
    await expect(safeMediaPath(join(root, "escape"), [root])).rejects.toThrow(
      "symlink",
    );
  });
  it("rejects a mapping directory symlink escape", async () => {
    await symlink(directory, join(root, "escape"));
    await expect(
      validateMappingRoot(join(root, "escape"), [root]),
    ).rejects.toThrow("symlink");
  });
  it("rejects mappings outside explicitly approved roots", async () => {
    await expect(validateMappingRoot(directory, [root])).rejects.toThrow(
      "MEDIA_ROOTS",
    );
  });
  it("rejects missing files and directories as media", async () => {
    await expect(
      safeMediaPath(join(root, "missing"), [root]),
    ).rejects.toThrow();
    await expect(safeMediaPath(root, [root])).rejects.toThrow("regular file");
  });
  it("rejects prefix collisions", async () => {
    await expect(safeMediaPath(`${root}-other/file`, [root])).rejects.toThrow(
      "outside",
    );
  });
});
