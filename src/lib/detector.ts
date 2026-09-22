import { z } from "zod";
import { normalizeLanguage } from "./language";
import type { ScanResult } from "./types";

export const detectionEvidence = z.object({
  language: z.string().min(2).max(32),
  confidence: z.number().min(0).max(1),
  detector: z.string().min(1).max(80),
  version: z.string().min(1).max(80),
  samples: z
    .array(
      z.object({
        streamIndex: z.number().int().nonnegative(),
        startSeconds: z.number().nonnegative(),
        durationSeconds: z.number().positive().max(30),
        speechSeconds: z.number().nonnegative().max(30),
      }),
    )
    .min(1)
    .max(3),
});
export type DetectionEvidence = z.infer<typeof detectionEvidence>;
export interface LanguageDetector {
  readonly id: string;
  /** Adapter receives bounded PCM samples, never arbitrary paths or cloud credentials. */
  detect(
    samples: readonly {
      streamIndex: number;
      startSeconds: number;
      durationSeconds: number;
      pcm16: Uint8Array;
    }[],
    signal: AbortSignal,
  ): Promise<DetectionEvidence>;
}
export function samplingPlan(duration: number, sampleSeconds = 20) {
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !Number.isFinite(sampleSeconds)
  )
    throw new Error("A valid program duration is required");
  const length = Math.min(30, Math.max(1, sampleSeconds), duration);
  return [
    ...new Set(
      [0.2, 0.5, 0.8].map((ratio) =>
        Math.max(0, Math.min(duration - length, duration * ratio)),
      ),
    ),
  ].map((startSeconds) => ({ startSeconds, durationSeconds: length }));
}
export async function detectAmbiguous(
  scan: ScanResult,
  detector: LanguageDetector | undefined,
  samples: Parameters<LanguageDetector["detect"]>[0],
  threshold = 0.85,
): Promise<{
  status: "metadata" | "not-installed" | "inconclusive" | "detected";
  evidence?: DetectionEvidence;
}> {
  if (scan.decision !== "needs-analysis") return { status: "metadata" };
  if (!detector) return { status: "not-installed" };
  if (
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold > 1 ||
    !samples.length ||
    samples.length > 3 ||
    samples.some(
      (sample) =>
        !Number.isInteger(sample.streamIndex) ||
        sample.streamIndex < 0 ||
        !Number.isFinite(sample.startSeconds) ||
        sample.startSeconds < 0 ||
        !Number.isFinite(sample.durationSeconds) ||
        sample.durationSeconds <= 0 ||
        sample.durationSeconds > 30 ||
        !sample.pcm16.byteLength ||
        sample.pcm16.byteLength % 2 !== 0 ||
        sample.pcm16.byteLength > sample.durationSeconds * 16000 * 2,
    )
  )
    return { status: "inconclusive" };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Detector timed out"));
      }, 15000);
    });
    const evidence = detectionEvidence.parse(
      await Promise.race([
        detector.detect(samples, controller.signal),
        timeout,
      ]),
    );
    evidence.language = normalizeLanguage(evidence.language);
    if (
      evidence.detector !== detector.id ||
      evidence.samples.some(
        (item) =>
          item.speechSeconds > item.durationSeconds ||
          !samples.some(
            (sample) =>
              sample.streamIndex === item.streamIndex &&
              sample.startSeconds === item.startSeconds &&
              sample.durationSeconds === item.durationSeconds,
          ),
      )
    )
      return { status: "inconclusive" };
    if (
      evidence.language === "und" ||
      evidence.confidence < threshold ||
      !evidence.samples.some((sample) => sample.speechSeconds >= 2)
    )
      return { status: "inconclusive", evidence };
    return { status: "detected", evidence };
  } catch {
    return { status: "inconclusive" };
  } finally {
    clearTimeout(timer);
  }
}
