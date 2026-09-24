import { constants } from "node:os";
import { spawn } from "node:child_process";

/** Diagnostic values are authored categories/numbers, never raw child output. */
export class InspectionError extends Error {
  constructor(
    message: string,
    readonly diagnostics: {
      stage: "process" | "parse";
      category: string;
      exitCode?: number | null;
      signal?: string | null;
      systemCode?: string;
      stdoutBytes: number;
      stderrBytes?: number;
      stderrTruncated?: boolean;
      stderrSummary?: string;
    },
    readonly retryable = false,
  ) {
    super(message);
  }
}

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
    let bytes = 0,
      stderrBytes = 0;
    const stderr = Buffer.alloc(4096);
    let category = "exit",
      systemCode: string | undefined;
    let failure: Error | undefined;
    const stop = (error: Error, reason: string) => {
      if (!failure) category = reason;
      failure ||= error;
      child.kill("SIGKILL");
    };
    const abort = () =>
      stop(new Error("Media inspection cancelled"), "cancelled");
    const timer = setTimeout(
      () => stop(new Error("Media inspection timed out"), "timeout"),
      options.timeoutMs ?? 20_000,
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on("data", (data: Buffer) => {
      bytes += data.length;
      if (bytes > (options.maxBytes ?? 2_000_000))
        stop(
          new Error("Media metadata exceeds the size limit"),
          "output-limit",
        );
      else chunks.push(data);
    });
    child.stderr.on("data", (data: Buffer) => {
      if (stderrBytes < stderr.length) data.copy(stderr, stderrBytes);
      stderrBytes += data.length;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (!failure) category = "spawn";
      systemCode = [
        "ENOENT",
        "EACCES",
        "EPERM",
        "EAGAIN",
        "ENOMEM",
        "EMFILE",
        "ENFILE",
        "EIO",
      ].includes(error.code || "")
        ? error.code
        : "OTHER";
      failure ||= new Error("Media inspection executable is unavailable");
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (failure || code !== 0) {
        const sample = stderr
          .subarray(0, Math.min(stderrBytes, stderr.length))
          .toString("utf8")
          .toLowerCase();
        const summary =
          [
            "permission denied",
            "no such file or directory",
            "invalid data found",
            "input/output error",
            "resource temporarily unavailable",
            "cannot allocate memory",
            "too many open files",
          ].find((text) => sample.includes(text)) ||
          (stderrBytes ? "unrecognized stderr withheld" : "no stderr");
        const retryable =
          (category === "spawn" &&
            ["EAGAIN", "ENOMEM", "EMFILE", "ENFILE", "EIO"].includes(
              systemCode || "",
            )) ||
          (!failure &&
            [
              "input/output error",
              "resource temporarily unavailable",
              "cannot allocate memory",
              "too many open files",
            ].includes(summary));
        reject(
          new InspectionError(
            failure?.message ||
              "Media inspection failed; verify the file is readable and valid",
            {
              stage: "process",
              category: !failure && signal ? "signal" : category,
              exitCode: code,
              signal:
                signal && Object.hasOwn(constants.signals, signal)
                  ? signal
                  : null,
              systemCode,
              stdoutBytes: bytes,
              stderrBytes,
              stderrTruncated: stderrBytes > stderr.length,
              stderrSummary: summary,
            },
            retryable,
          ),
        );
      } else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}
