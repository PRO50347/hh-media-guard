/** Only explicitly authored messages may cross a diagnostics/API boundary. */
export class SafeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function safeMessage(
  error: unknown,
  fallback = "Initialization failed; check configuration and retry.",
) {
  return error instanceof SafeError ? error.message : fallback;
}
