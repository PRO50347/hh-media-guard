import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SafeError } from "./safe-error";
export function configDiagnostics(
  configPath = process.env.CONFIG_DIR || path.join(process.cwd(), "config"),
) {
  const access = (mode: number) => {
    try {
      fs.accessSync(configPath, mode);
      return true;
    } catch {
      return false;
    }
  };
  return {
    CONFIG_PATH: configPath,
    CONFIG_EXISTS: fs.existsSync(configPath),
    CONFIG_READABLE: access(fs.constants.R_OK | fs.constants.X_OK),
    CONFIG_WRITABLE: access(fs.constants.W_OK | fs.constants.X_OK),
    RUNTIME_UID: process.getuid?.(),
    RUNTIME_GID: process.getgid?.(),
  };
}
export function validateConfig(configPath?: string) {
  const info = configDiagnostics(configPath);
  if (!info.CONFIG_EXISTS)
    throw new SafeError(
      "config.missing",
      "Configuration directory does not exist; mount/create /config before startup.",
    );
  if (!info.CONFIG_READABLE)
    throw new SafeError(
      "config.unreadable",
      "Configuration directory is not readable/searchable by the runtime UID/GID.",
    );
  if (!info.CONFIG_WRITABLE)
    throw new SafeError(
      "config.unwritable",
      "Configuration directory is not writable by the runtime UID/GID. Check the bind mount and PUID/PGID.",
    );
  const probe = path.join(info.CONFIG_PATH, `.write-check-${randomUUID()}`);
  try {
    fs.writeFileSync(probe, "", { flag: "wx", mode: 0o600 });
    fs.unlinkSync(probe);
  } catch {
    throw new SafeError(
      "config.unwritable",
      "Configuration directory cannot create/remove files; check permissions, read-only mount and free space.",
    );
  }
}
export function startupFailure(error: unknown) {
  return {
    event: "startup.failed",
    code: error instanceof SafeError ? error.code : "initialization.failed",
    message:
      error instanceof SafeError
        ? error.message
        : "Initialization failed. Check configuration and available storage; no sensitive exception details were logged.",
    ...configDiagnostics(),
  };
}
