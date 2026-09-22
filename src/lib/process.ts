import { spawn } from "node:child_process";

/** Bounded, cancellable argument-array invocation. Never includes child stderr
 * in errors: media metadata may contain untrusted or sensitive text. */
export function runProcess(
  executable: string,
  args: string[],
  options: { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    const stop = (error: Error) => {
      failure ||= error;
      child.kill("SIGKILL");
    };
    const abort = () => stop(new Error("Media inspection cancelled"));
    const timer = setTimeout(
      () => stop(new Error("Media inspection timed out")),
      options.timeoutMs ?? 20_000,
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on("data", (data: Buffer) => {
      bytes += data.length;
      if (bytes > (options.maxBytes ?? 2_000_000))
        stop(new Error("Media metadata exceeds the size limit"));
      else chunks.push(data);
    });
    child.stderr.on("data", () => {});
    child.on("error", () => {
      failure ||= new Error("Media inspection executable is unavailable");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new Error(
            "Media inspection failed; verify the file is readable and valid",
          ),
        );
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}
