import { constants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  audit,
  getConfigDir,
  getSettings,
  quarantine,
  raw,
  roots,
  needsAttention,
} from "./store";
import { safeMediaPath, validAbsolute, within } from "./security";
import { fingerprint } from "./scanner";
import type { ScanResult } from "./types";
import { decideAudio } from "./rules";

function permitted() {
  if (
    process.env.ALLOW_DESTRUCTIVE_ACTIONS !== "true" ||
    !["quarantine", "automatic"].includes(getSettings().safetyMode)
  )
    throw new Error(
      "Explicit quarantine/automatic mode and ALLOW_DESTRUCTIVE_ACTIONS=true are required",
    );
}
async function quarantineRoot() {
  const root = validAbsolute(getSettings().quarantinePath || "");
  if (
    root === "/" ||
    (await realpath(root)) !== root ||
    !(await lstat(root)).isDirectory()
  )
    throw new Error("Use an existing, non-symlink quarantine directory");
  for (const protectedRoot of [getConfigDir(), ...roots()]) {
    const canonical = await realpath(protectedRoot);
    if (within(root, canonical) || within(canonical, root))
      throw new Error(
        "Quarantine must be separate from config and mapped media",
      );
  }
  return root;
}
function same(
  a: { dev: number; ino: number; size: number; mtimeMs: number },
  b: { dev: number; ino: number; size: number; mtimeMs: number },
) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs
  );
}

/** Exclusive destination creation never overwrites a replacement or existing restore target.
 * On any failure, retain both copies for recovery rather than deleting uncertain data. */
export async function moveExclusive(
  source: string,
  target: string,
  linkFile = link,
) {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await input.stat();
    if (!before.isFile()) throw new Error("Source is not a regular file");
    try {
      await linkFile(source, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      const output = await open(target, "wx", 0o600);
      try {
        const buffer = Buffer.alloc(1024 * 1024);
        let offset = 0;
        for (;;) {
          const { bytesRead } = await input.read(
            buffer,
            0,
            buffer.length,
            offset,
          );
          if (!bytesRead) break;
          let written = 0;
          while (written < bytesRead) {
            const result = await output.write(
              buffer,
              written,
              bytesRead - written,
              offset + written,
            );
            if (!result.bytesWritten)
              throw new Error("Quarantine copy stalled");
            written += result.bytesWritten;
          }
          offset += bytesRead;
        }
        await output.sync();
        if (offset !== before.size)
          throw new Error("Source changed during copy");
      } finally {
        await output.close();
      }
    }
    const after = await input.stat();
    if (!same(before, after) || !same(before, await lstat(source)))
      throw new Error("Source identity changed; originals retained");
    const destination = await lstat(target);
    if (!destination.isFile() || destination.size !== before.size)
      throw new Error("Quarantine copy could not be verified");
    // Flush the new directory entry before removing the original entry.
    const directory = await open(path.dirname(target), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    await unlink(source);
    const sourceDirectory = await open(path.dirname(source), "r");
    try {
      await sourceDirectory.sync();
    } finally {
      await sourceDirectory.close();
    }
  } finally {
    await input.close();
  }
}

export async function moveToQuarantine(scan: ScanResult) {
  permitted();
  if (scan.decision !== "fail" || !scan.fingerprint)
    throw new Error("A conclusive, persisted failed scan is required");
  const stored = raw()
    .prepare("SELECT data FROM scans WHERE fingerprint=? AND decision='fail'")
    .get(scan.fingerprint) as { data: string } | undefined;
  if (!stored || JSON.parse(stored.data).path !== scan.path)
    throw new Error("Persisted evidence does not match");
  scan = JSON.parse(stored.data) as ScanResult;
  if (
    decideAudio(scan.duration, scan.tracks, getSettings()).decision !== "fail"
  )
    throw new Error("Stored evidence is no longer conclusive");
  const original = await safeMediaPath(scan.path, roots());
  if ((await fingerprint(original, getSettings())) !== scan.fingerprint)
    throw new Error("Media or policy changed since scanning");
  const root = await quarantineRoot();
  const id = randomUUID();
  const target = path.join(
    root,
    id +
      path
        .extname(original)
        .replace(/[^a-zA-Z0-9.]/g, "")
        .slice(0, 12),
  );
  const evidence = JSON.stringify({ scan, originalPath: original });
  const existing = raw()
    .transaction(() => {
      const prior = raw()
        .prepare(
          "SELECT id FROM quarantines WHERE original_path=? AND evidence=?",
        )
        .get(original, evidence) as { id: string } | undefined;
      if (prior) return prior.id;
      raw()
        .prepare("INSERT INTO quarantines VALUES(?,?,?,?,?,?,?)")
        .run(
          id,
          original,
          target,
          evidence,
          "moving",
          new Date().toISOString(),
          null,
        );
      audit("quarantine", `Planned quarantine ${id}`);
      return undefined;
    })
    .immediate();
  if (existing)
    throw new Error(
      "An operation already exists for this evidence; inspect its recovery state",
    );
  try {
    permitted();
    if (
      (await quarantineRoot()) !== root ||
      (await safeMediaPath(original, roots())) !== original
    )
      throw new Error("Filesystem boundaries changed");
    await moveExclusive(original, target);
    raw()
      .prepare(
        "UPDATE quarantines SET state='quarantined' WHERE id=? AND state='moving'",
      )
      .run(id);
    audit("quarantine", `Quarantined ${id}`);
    return id;
  } catch (error) {
    raw()
      .prepare("UPDATE quarantines SET state='needs-attention' WHERE id=?")
      .run(id);
    needsAttention(id, "quarantine failure", {
      operationId: id,
      error:
        "Movement incomplete. Inspect both recorded paths before retrying.",
    });
    throw error;
  }
}
export async function restoreFromQuarantine(id: string) {
  permitted();
  const item = quarantine(id);
  if (!item || item.state !== "quarantined")
    throw new Error("Active quarantine not found");
  const root = await quarantineRoot();
  if (
    !within(root, item.quarantine_path) ||
    (await realpath(item.quarantine_path)) !== item.quarantine_path
  )
    throw new Error("Unsafe quarantine source");
  const parent = await realpath(
    path.dirname(validAbsolute(item.original_path)),
  );
  if (parent !== path.dirname(item.original_path))
    throw new Error("Restore parent changed");
  let allowed = false;
  for (const mediaRoot of roots())
    if (within(await realpath(mediaRoot), parent)) allowed = true;
  if (!allowed) throw new Error("Restore destination is no longer mapped");
  const changed = raw()
    .prepare(
      "UPDATE quarantines SET state='restoring' WHERE id=? AND state='quarantined'",
    )
    .run(id).changes;
  if (!changed) throw new Error("Operation is already claimed");
  try {
    permitted();
    await moveExclusive(item.quarantine_path, item.original_path);
    raw()
      .prepare(
        "UPDATE quarantines SET state='restored',restored_at=? WHERE id=?",
      )
      .run(new Date().toISOString(), id);
    audit("quarantine", `Restored ${id}`, "admin");
  } catch (error) {
    raw()
      .prepare("UPDATE quarantines SET state='needs-attention' WHERE id=?")
      .run(id);
    needsAttention(id, "restore failure", {
      operationId: id,
      error: "Restore incomplete. Existing files were not overwritten.",
    });
    throw error;
  }
}
