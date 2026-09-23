import fs from "node:fs";
import path from "node:path";

class BootstrapError extends Error {}

export function runtimeId(value, fallback) {
  const text = value ?? String(fallback);
  if (!/^[1-9][0-9]{0,9}$/.test(text) || Number(text) > 2147483647)
    throw new BootstrapError(
      "PUID and PGID must be non-zero decimal IDs below 2147483648.",
    );
  return Number(text);
}
const contains = (parent, child) =>
  child === parent || child.startsWith(parent + "/");
const overlaps = (a, b) => contains(a, b) || contains(b, a);
const unescapeMount = (s) =>
  s.replace(/\\([0-7]{3})/g, (_, n) => String.fromCharCode(parseInt(n, 8)));
export function checkMounts(text, roots) {
  const mounts = text
    .trim()
    .split("\n")
    .map((line) => {
      const f = line.split(" ");
      return {
        device: f[2],
        root: unescapeMount(f[3]),
        at: unescapeMount(f[4]),
      };
    });
  if (mounts.some((m) => m.at.startsWith("/config/")))
    throw new BootstrapError("Nested mounts inside /config are not supported.");
  const backing = (p) => {
    const m = mounts
      .filter((m) => m.at === "/" || contains(m.at, p))
      .sort((a, b) => b.at.length - a.at.length)[0];
    if (!m) throw new BootstrapError("Cannot determine mount boundaries.");
    return {
      device: m.device,
      root: path.posix.join(m.root, path.posix.relative(m.at, p)),
    };
  };
  const config = backing("/config");
  for (const root of roots) {
    if (overlaps("/config", root) || root === "/")
      throw new BootstrapError("/config must not overlap a media root.");
    const media = backing(root);
    if (config.device === media.device && overlaps(config.root, media.root))
      throw new BootstrapError(
        "/config and media refer to overlapping backing storage.",
      );
  }
}
export function initializeConfig() {
  const uid = runtimeId(process.env.PUID, 100),
    gid = runtimeId(process.env.PGID, 101);
  if ((process.env.CONFIG_DIR || "/config") !== "/config")
    throw new BootstrapError(
      "Container CONFIG_DIR must be /config; alternate paths are not ownership-managed.",
    );
  const roots = [
    ...new Set(
      [
        "/Media",
        "/movies",
        "/tv",
        ...(process.env.MEDIA_ROOTS || "").split(",").filter(Boolean),
      ].map((p) => {
        if (!path.isAbsolute(p))
          throw new BootstrapError("MEDIA_ROOTS must use absolute paths.");
        const normalized = path.resolve(p);
        return fs.existsSync(normalized)
          ? fs.realpathSync(normalized)
          : normalized;
      }),
    ),
  ];
  checkMounts(fs.readFileSync("/proc/self/mountinfo", "utf8"), roots);
  if (process.getuid() !== 0) {
    if (
      (process.env.PUID && uid !== process.getuid()) ||
      (process.env.PGID && gid !== process.getgid())
    )
      throw new BootstrapError(
        "Explicit Docker --user must match configured PUID/PGID.",
      );
    return; // Explicit non-root --user: application preflight diagnoses permissions.
  }
  if (!fs.existsSync("/config")) fs.mkdirSync("/config", { mode: 0o700 });
  // No recursive chown/chmod. Open a fixed allowlist through pinned directory FDs.
  // O_NOFOLLOW and nlink=1 prevent symlink and hardlink escapes.
  const opened = [];
  const open = (name, directory) => {
    const fd = fs.openSync(
      name,
      fs.constants.O_RDONLY |
        fs.constants.O_NOFOLLOW |
        fs.constants.O_NONBLOCK |
        (directory ? fs.constants.O_DIRECTORY : 0),
    );
    const stat = fs.fstatSync(fd);
    opened.push(fd);
    if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
      throw new BootstrapError(
        "Unsafe application-owned entry in /config; no ownership changes made.",
      );
    return fd;
  };
  try {
    const root = open("/config", true);
    const base = `/proc/self/fd/${root}`;
    for (const name of [
      "media-guard.db",
      "media-guard.db-wal",
      "media-guard.db-shm",
    ]) {
      if (fs.lstatSync(`${base}/${name}`, { throwIfNoEntry: false }))
        open(`${base}/${name}`, false);
    }
    if (fs.lstatSync(`${base}/branding`, { throwIfNoEntry: false })) {
      const branding = open(`${base}/branding`, true);
      for (const name of fs.readdirSync(`/proc/self/fd/${branding}`))
        open(`/proc/self/fd/${branding}/${name}`, false);
    }
    // All validation precedes writes. Unknown files/directories are left untouched.
    for (const fd of opened) fs.fchownSync(fd, uid, gid);
  } finally {
    for (const fd of opened) fs.closeSync(fd);
  }
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    initializeConfig();
  } catch (error) {
    // Never emit filesystem exceptions: administrator-supplied paths may contain secrets.
    console.error(
      JSON.stringify({
        event: "startup.failed",
        code: "config.bootstrap",
        message:
          error instanceof BootstrapError
            ? error.message
            : "Config permission bootstrap failed; check writable /config and safe regular files (no symlinks/hardlinks).",
        CONFIG_PATH: "/config",
        CONFIG_EXISTS: fs.existsSync("/config"),
        CONFIG_READABLE: (() => {
          try {
            fs.accessSync("/config", fs.constants.R_OK | fs.constants.X_OK);
            return true;
          } catch {
            return false;
          }
        })(),
        CONFIG_WRITABLE: (() => {
          try {
            fs.accessSync("/config", fs.constants.W_OK | fs.constants.X_OK);
            return true;
          } catch {
            return false;
          }
        })(),
        RUNTIME_UID: process.getuid(),
        RUNTIME_GID: process.getgid(),
      }),
    );
    process.exit(1);
  }
}
