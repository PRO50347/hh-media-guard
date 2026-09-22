export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.MG_BUILD === "1") return;
    try {
      const { initializeRuntime } = await import("./lib/runtime");
      await initializeRuntime();
    } catch {
      // Next may retain its listener after a rejected instrumentation hook.
      // Fail closed without serializing exceptions containing configuration.
      console.error(
        JSON.stringify({
          event: "startup.failed",
          message:
            "Check ENCRYPTION_KEY (32-byte base64), exact APP_URL/ALLOWED_ORIGINS, /config permissions, and exclusive runtime ownership. After a crash allow 30 seconds for lease expiry.",
        }),
      );
      process.exit(1);
    }
  }
}
