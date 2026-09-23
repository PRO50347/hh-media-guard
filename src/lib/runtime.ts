import { validateConfig } from "./startup";
import { SafeError } from "./safe-error";
export async function initializeRuntime() {
  const { validateEncryptionKey } = await import("./crypto");
  const { allowedOrigins } = await import("./origin");
  validateEncryptionKey();
  allowedOrigins();
  validateConfig();
  let store;
  try {
    store = await import("./store");
  } catch {
    throw new SafeError(
      "database.open",
      "Database cannot be opened or migrated. Check /config database permissions, free space and backup integrity.",
    );
  }
  const { raw } = store;
  const { RuntimeLease, attachRuntimeLease } = await import("./runtime-lease");
  const lease = new RuntimeLease(raw());
  if (!lease.acquire())
    throw new SafeError(
      "runtime.conflict",
      "Another Media Guard runtime owns /config. Stop it first, or wait 30 seconds after a crash.",
    );
  attachRuntimeLease(lease);
  const { startWorker, stopWorker } = await import("./worker");
  startWorker();
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(leaseTimer);
    void stopWorker()
      .then(() => {
        lease.release();
        process.exit(0);
      })
      .catch(() => process.exit(1));
  };
  const leaseTimer = setInterval(() => {
    try {
      if (!lease.renew()) shutdown();
    } catch {
      shutdown();
    }
  }, 10000);
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
