import Database from "better-sqlite3";
import { mkdir, readFile, writeFile, copyFile, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function regular(file) {
  if (!(await lstat(file)).isFile())
    throw new Error("Only regular files may be backed up or restored");
}
export async function backupConfig(source, destination) {
  source = path.resolve(source);
  destination = path.resolve(destination);
  await regular(path.join(source, "media-guard.db"));
  // Exclusive new directory: never overwrite an existing backup or installation.
  await mkdir(destination, { mode: 0o700 });
  const db = new Database(path.join(source, "media-guard.db"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    await db.backup(path.join(destination, "media-guard.db"));
  } finally {
    db.close();
  }
  const snapshot = new Database(path.join(destination, "media-guard.db"), {
    readonly: true,
  });
  const files = ["media-guard.db"];
  try {
    if (snapshot.pragma("integrity_check", { simple: true }) !== "ok")
      throw new Error("Database integrity check failed");
    const hasAssets = snapshot
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='branding_assets'",
      )
      .get();
    if (hasAssets) {
      const assets = snapshot
        .prepare("SELECT DISTINCT filename FROM branding_assets")
        .all();
      if (assets.length)
        await mkdir(path.join(destination, "branding"), { mode: 0o700 });
      for (const { filename } of assets) {
        if (!/^[a-f0-9-]{36}\.png$/.test(filename))
          throw new Error("Unsafe branding filename");
        const relative = `branding/${filename}`;
        await regular(path.join(source, relative));
        await copyFile(
          path.join(source, relative),
          path.join(destination, relative),
          constants.COPYFILE_EXCL,
        );
        files.push(relative);
      }
    }
  } finally {
    snapshot.close();
  }
  const manifest = {
    format: 1,
    createdAt: new Date().toISOString(),
    files: {},
  };
  for (const file of files)
    manifest.files[file] = hash(await readFile(path.join(destination, file)));
  await writeFile(
    path.join(destination, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    { flag: "wx", mode: 0o600 },
  );
  return manifest;
}
export async function restoreConfig(source, destination) {
  source = path.resolve(source);
  destination = path.resolve(destination);
  await regular(path.join(source, "manifest.json"));
  const manifest = JSON.parse(
    await readFile(path.join(source, "manifest.json"), "utf8"),
  );
  if (
    manifest.format !== 1 ||
    !manifest.files ||
    !manifest.files["media-guard.db"]
  )
    throw new Error("Unsupported backup");
  const files = Object.keys(manifest.files);
  if (files.length > 5) throw new Error("Unexpected backup entries");
  for (const file of files) {
    if (
      file !== "media-guard.db" &&
      !/^branding\/[a-f0-9-]{36}\.png$/.test(file)
    )
      throw new Error("Unsafe backup path");
    await regular(path.join(source, file));
    if (hash(await readFile(path.join(source, file))) !== manifest.files[file])
      throw new Error("Backup checksum mismatch");
  }
  const check = new Database(path.join(source, "media-guard.db"), {
    readonly: true,
  });
  try {
    if (check.pragma("integrity_check", { simple: true }) !== "ok")
      throw new Error("Database integrity check failed");
  } finally {
    check.close();
  }
  await mkdir(destination, { mode: 0o700 });
  if (files.some((file) => file.startsWith("branding/")))
    await mkdir(path.join(destination, "branding"), { mode: 0o700 });
  for (const file of files)
    await copyFile(
      path.join(source, file),
      path.join(destination, file),
      constants.COPYFILE_EXCL,
    );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [command, source, destination] = process.argv.slice(2);
  if (!["backup", "restore"].includes(command) || !source || !destination) {
    console.error(
      "Usage: node scripts/config-backup.mjs backup|restore SOURCE NEW_DESTINATION",
    );
    process.exitCode = 1;
  } else
    try {
      await (command === "backup" ? backupConfig : restoreConfig)(
        source,
        destination,
      );
      console.log(
        `${command} complete. Keep ENCRYPTION_KEY separately. Restore requires a stopped application.`,
      );
    } catch (error) {
      console.error(`${command} failed: ${error.message}`);
      process.exitCode = 1;
    }
}
