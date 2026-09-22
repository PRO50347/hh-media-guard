import { describe, it, expect, vi } from "vitest";
import {
  detectAmbiguous,
  samplingPlan,
  type LanguageDetector,
} from "../src/lib/detector";
import type { ScanResult } from "../src/lib/types";
const scan: ScanResult = {
  path: "/generated/sample",
  decision: "needs-analysis",
  reason: "Unknown",
  tracks: [],
  scannedAt: "fixture",
};
const samples = [
  {
    streamIndex: 0,
    startSeconds: 20,
    durationSeconds: 20,
    pcm16: new Uint8Array(100),
  },
];
describe("optional detector contract (no model bundled)", () => {
  const evidence = {
    language: "English",
    confidence: 0.95,
    detector: "fixture",
    version: "test",
    samples: [
      {
        streamIndex: 0,
        startSeconds: 20,
        durationSeconds: 20,
        speechSeconds: 10,
      },
    ],
  };
  it("normalizes valid evidence without changing the scan decision", async () => {
    const result = await detectAmbiguous(
      scan,
      { id: "fixture", detect: async () => evidence },
      samples,
    );
    expect(result).toMatchObject({
      status: "detected",
      evidence: { language: "eng" },
    });
    expect(scan.decision).toBe("needs-analysis");
  });
  it("rejects invented timestamps, excessive speech, and mismatched detector identity", async () => {
    for (const changed of [
      { ...evidence, detector: "other" },
      { ...evidence, samples: [{ ...evidence.samples[0], startSeconds: 500 }] },
      { ...evidence, samples: [{ ...evidence.samples[0], speechSeconds: 21 }] },
    ])
      expect(
        await detectAmbiguous(
          scan,
          { id: "fixture", detect: async () => changed },
          samples,
        ),
      ).toEqual({ status: "inconclusive" });
  });
  it("rejects invalid sample limits and confidence thresholds before invocation", async () => {
    const detect = vi.fn();
    for (const seconds of [NaN, -1, 0, 31])
      expect(
        await detectAmbiguous(scan, { id: "fixture", detect }, [
          { ...samples[0], durationSeconds: seconds },
        ]),
      ).toEqual({ status: "inconclusive" });
    expect(
      await detectAmbiguous(scan, { id: "fixture", detect }, samples, NaN),
    ).toEqual({ status: "inconclusive" });
    expect(detect).not.toHaveBeenCalled();
    expect(() => samplingPlan(20, NaN)).toThrow();
  });
  it("times out an unresponsive adapter and signals cancellation", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    try {
      const pending = detectAmbiguous(
        scan,
        {
          id: "fixture",
          detect: async (_samples, abort) => {
            signal = abort;
            return new Promise(() => {});
          },
        },
        samples,
      );
      await vi.advanceTimersByTimeAsync(15000);
      expect(await pending).toEqual({ status: "inconclusive" });
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not invoke detection for conclusive metadata", async () => {
    const detect = vi.fn();
    expect(
      await detectAmbiguous(
        { ...scan, decision: "pass" },
        { id: "fixture", detect },
        samples,
      ),
    ).toEqual({ status: "metadata" });
    expect(detect).not.toHaveBeenCalled();
  });
  it("reports the uninstalled adapter honestly", async () => {
    expect(await detectAmbiguous(scan, undefined, samples)).toEqual({
      status: "not-installed",
    });
  });
  it("adapter failures cannot turn uncertain media into a rejection", async () => {
    const detector: LanguageDetector = {
      id: "fixture",
      detect: async () => {
        throw new Error("Unavailable");
      },
    };
    expect(await detectAmbiguous(scan, detector, samples)).toEqual({
      status: "inconclusive",
    });
    expect(scan.decision).toBe("needs-analysis");
  });
  it("samples bounded distinct portions of a program", () => {
    expect(samplingPlan(100, 20)).toEqual([
      { startSeconds: 20, durationSeconds: 20 },
      { startSeconds: 50, durationSeconds: 20 },
      { startSeconds: 80, durationSeconds: 20 },
    ]);
    expect(samplingPlan(1, 20)).toEqual([
      { startSeconds: 0, durationSeconds: 1 },
    ]);
    expect(() => samplingPlan(0)).toThrow();
  });
});
