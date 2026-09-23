export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.MG_BUILD === "1") return;
    try {
      const { initializeRuntime } = await import("./lib/runtime");
      await initializeRuntime();
    } catch (error) {
      const { startupFailure } = await import("./lib/startup");
      console.error(JSON.stringify(startupFailure(error)));
      process.exit(1);
    }
  }
}
