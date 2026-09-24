import { StringDecoder } from "node:string_decoder";
import { SafeError } from "./safe-error";

/** API v3 library lists are not paged. Parse one object at a time, discard
 * unused fields immediately, and bound wire bytes, record size/count and output.
 * Ordinary API requests keep their separate 4 MB buffered-response limit. */
export const ARRAY_LIMITS = {
  bytes: 64_000_000,
  recordChars: 128_000,
  records: 100_000,
  projectedBytes: 16_000_000,
  depth: 64,
} as const;
export class ArrArrayReader {
  private decoder = new StringDecoder("utf8");
  private state: "start" | "first" | "value" | "record" | "separator" | "end" =
    "start";
  private record = "";
  private depth = 0;
  private quoted = false;
  private escaped = false;
  private bytes = 0;
  private count = 0;
  private projected = 0;
  private result: unknown[] = [];
  constructor(private readonly project: (value: unknown) => unknown) {}
  private invalid(): never {
    throw new SafeError(
      "arr.response",
      "Invalid or truncated Arr library JSON array.",
    );
  }
  private limit(): never {
    throw new SafeError(
      "arr.response",
      "Arr library exceeds a bounded enumeration limit (64 MB response, 128K-character record, 100,000 records or 16 MB retained metadata).",
    );
  }
  write(chunk: Buffer) {
    this.bytes += chunk.length;
    if (this.bytes > ARRAY_LIMITS.bytes) this.limit();
    this.consume(this.decoder.write(chunk));
  }
  private consume(text: string) {
    for (const c of text) {
      if (this.state === "record") {
        this.record += c;
        if (this.record.length > ARRAY_LIMITS.recordChars) this.limit();
        if (this.quoted) {
          if (this.escaped) this.escaped = false;
          else if (c === "\\") this.escaped = true;
          else if (c === '"') this.quoted = false;
        } else if (c === '"') this.quoted = true;
        else if (c === "{" || c === "[") {
          if (++this.depth > ARRAY_LIMITS.depth) this.limit();
        } else if (c === "}" || c === "]") {
          if (--this.depth === 0) {
            let value: unknown;
            try {
              value = JSON.parse(this.record);
            } catch {
              this.invalid();
            }
            if (++this.count > ARRAY_LIMITS.records) this.limit();
            let compact: unknown;
            try {
              compact = this.project(value);
            } catch {
              throw new SafeError(
                "arr.response",
                "Unexpected Arr library record; check API v3 compatibility.",
              );
            }
            this.projected += Buffer.byteLength(JSON.stringify(compact));
            if (this.projected > ARRAY_LIMITS.projectedBytes) this.limit();
            this.result.push(compact);
            this.record = "";
            this.state = "separator";
          }
        }
      } else {
        if (/^[\t\n\r ]$/.test(c)) continue;
        if (this.state === "start" && c === "[") this.state = "first";
        else if (
          (this.state === "first" || this.state === "value") &&
          c === "{"
        ) {
          this.record = "{";
          this.depth = 1;
          this.state = "record";
        } else if (
          (this.state === "first" || this.state === "separator") &&
          c === "]"
        )
          this.state = "end";
        else if (this.state === "separator" && c === ",") this.state = "value";
        else this.invalid();
      }
    }
  }
  finish() {
    this.consume(this.decoder.end());
    if (this.state !== "end") this.invalid();
    return this.result;
  }
}
