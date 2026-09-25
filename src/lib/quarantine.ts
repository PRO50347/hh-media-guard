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
import { requireRuntimeOwnership } from "./runtime-lease";

function permitted() {
  requireRuntimeOwnership();
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

// Linux directory descriptors pin both parents throughout a move. A renamed
// parent or symlink swap must not redirect the final unlink or restore write.
async function openDirectory(input: string) {
  const resolved = validAbsolute(input);
  let handle = await open("/", constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const part of resolved.split("/").filter(Boolean)) {
      const next = await open(
        `/proc/self/fd/${handle.fd}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      await handle.close();
      handle = next;
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Exclusive destination creation never overwrites a replacement or existing restore target.
 * On any failure, retain both copies for recovery rather than deleting uncertain data. */
export async function moveExclusive(
  source: string,
  target: string,
  linkFile = link,
  beforeUnlink: () => void = () => {},
  expectedSource?: { dev: number; ino: number; size: number; mtimeMs: number },
) {
  const sourceParent = await openDirectory(path.dirname(source));
  let targetParent: Awaited<ReturnType<typeof openDirectory>> | undefined;
  let input: Awaited<ReturnType<typeof open>> | undefined;
  try {
    targetParent = await openDirectory(path.dirname(target));
    source = `/proc/self/fd/${sourceParent.fd}/${path.basename(source)}`;
    target = `/proc/self/fd/${targetParent.fd}/${path.basename(target)}`;
    // These are runtime media descriptors, never build-time application assets.
    input = await open(
      /* turbopackIgnore: true */ source,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const before = await input.stat();
    if (expectedSource && !same(expectedSource, before))
      throw new Error("Source changed after validation; original retained");
    let targetIdentity: Awaited<ReturnType<typeof lstat>>;
    if (!before.isFile()) throw new Error("Source is not a regular file");
    try {
      await linkFile(source, target);
      targetIdentity = await lstat(target);
      if (!same(before, targetIdentity))
        throw new Error("Hardlink identity mismatch; original retained");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      const output = await open(
        /* turbopackIgnore: true */ target,
        "wx",
        0o600,
      );
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
        targetIdentity = await output.stat();
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
    if (
      !destination.isFile() ||
      destination.size !== before.size ||
      !same(targetIdentity!, destination)
    )
      throw new Error("Quarantine copy could not be verified");
    // Flush the new directory entry before removing the original entry.
    await targetParent.sync();
    beforeUnlink();
    await unlink(source);
    await sourceParent.sync();
  } finally {
    await input?.close();
    await targetParent?.close();
    await sourceParent.close();
  }
}

export async function moveToQuarantine(
  scan: ScanResult,
  signal?: AbortSignal,
  requireJobOwnership: () => void = () => {},
) {
  const authorize = () => {
    requireJobOwnership();
    signal?.throwIfAborted();
    permitted();
  };
  authorize();
  if (scan.decision !== "fail" || !scan.fingerprint)
    throw new Error("A conclusive, persisted failed scan is required");
  const stored = raw()
    .prepare("SELECT data FROM scans WHERE fingerprint=? AND decision='fail'")
    .get(scan.fingerprint) as { data: string } | undefined;
  if (!stored || JSON.parse(stored.data).path !== scan.path)
    throw new Error("Persisted evidence does not match");
  scan = JSON.parse(stored.data) as ScanResult;
  if (
    decideAudio(scan.duration, scan.tracks, getSettings(), scan.arrFileEvidence)
      .decision !== "fail"
  )
    throw new Error("Stored evidence is no longer conclusive");
  const original = await safeMediaPath(scan.path, roots());
  const originalIdentity = await lstat(original);
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
          "SELECT id FROM quarantines WHERE original_path=? AND json_extract(evidence,'$.scan.fingerprint')=?",
        )
        .get(original, scan.fingerprint) as { id: string } | undefined;
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
    authorize();
    if (
      (await quarantineRoot()) !== root ||
      (await safeMediaPath(original, roots())) !== original
    )
      throw new Error("Filesystem boundaries changed");
    await moveExclusive(
      original,
      target,
      undefined,
      authorize,
      originalIdentity,
    );
    const kept = await lstat(target);
    const retainedIdentity = {
      dev: kept.dev,
      ino: kept.ino,
      size: kept.size,
      mtimeMs: kept.mtimeMs,
    };
    raw()
      .prepare(
        "UPDATE quarantines SET state='quarantined',evidence=? WHERE id=? AND state='moving'",
      )
      .run(
        JSON.stringify({ scan, originalPath: original, retainedIdentity }),
        id,
      );
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
    await moveExclusive(
      item.quarantine_path,
      item.original_path,
      undefined,
      permitted,
    );
    raw()
      .prepare(
        "UPDATE quarantines SET state='restored',restored_at=? WHERE id=?",
      )
      .run(new Date().toISOString(), id);
    audit("quarantine", `Restored ${id}`, "admin");
    raw()
      .prepare("UPDATE media_items SET action_state='none' WHERE path=?")
      .run(item.original_path);
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

/** Cleanup is opt-in and only dispatched after replacement verification. Pin the
 * quarantine parent and refuse changed copies or an in-flight restore. */
export async function removeVerifiedQuarantine(
  id: string,
  verifyReplacement: () => Promise<void>,
) {
  permitted();
  const item = quarantine(id);
  if (!item || item.state !== "quarantined")
    throw new Error("Active quarantine not found");
  const retained = JSON.parse(item.evidence).retainedIdentity as
    | { dev: number; ino: number; size: number; mtimeMs: number }
    | undefined;
  if (!retained)
    throw new Error(
      "Quarantine identity was not recorded; retain this copy for manual recovery",
    );
  const root = await quarantineRoot();
  if (
    path.dirname(item.quarantine_path) !== root ||
    (await realpath(item.quarantine_path)) !== item.quarantine_path
  )
    throw new Error("Unsafe quarantine cleanup path");
  const parent = await openDirectory(root);
  try {
    const pinned = `/proc/self/fd/${parent.fd}/${path.basename(item.quarantine_path)}`;
    const current = await lstat(pinned);
    if (!current.isFile() || !same(retained, current))
      throw new Error("Quarantined copy changed; cleanup refused");
    await verifyReplacement();
    permitted();
    if (
      (await quarantineRoot()) !== root ||
      !same(retained, await lstat(pinned))
    )
      throw new Error("Quarantine boundaries or copy changed");
    const claimed = raw()
      .prepare(
        "UPDATE quarantines SET state='cleaning' WHERE id=? AND state='quarantined'",
      )
      .run(id).changes;
    if (!claimed) throw new Error("Quarantine is already claimed");
    try {
      permitted();
      await unlink(pinned);
      await parent.sync();
      raw()
        .prepare(
          "UPDATE quarantines SET state='cleaned' WHERE id=? AND state='cleaning'",
        )
        .run(id);
      audit(
        "quarantine",
        `Removed failed copy ${id} after verified replacement and explicit confirmation`,
        "admin",
      );
    } catch (error) {
      raw()
        .prepare("UPDATE quarantines SET state='needs-attention' WHERE id=?")
        .run(id);
      needsAttention(id, "quarantine cleanup incomplete", {
        operationId: id,
        reason:
          "Inspect the recorded quarantine path; cleanup is never retried automatically.",
      });
      throw error;
    }
  } finally {
    await parent.close();
  }
}
