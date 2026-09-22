import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import { isCommentary, isDescriptive, normalizeLanguage } from "./language";
import { decideAudio } from "./rules";
import { getSettings } from "./store";
import { runProcess } from "./process";
import type { ScanResult, AudioTrack, Settings } from "./types";

const streamSchema = z.object({
  index: z.number().int(),
  codec_type: z.string(),
  codec_name: z.string().optional(),
  duration: z.string().optional(),
  bit_rate: z.string().optional(),
  channels: z.number().optional(),
  channel_layout: z.string().optional(),
  tags: z.record(z.string()).optional(),
  disposition: z.record(z.number()).optional(),
});
const probeSchema = z.object({
  format: z.object({ duration: z.string().optional() }).optional(),
  streams: z.array(streamSchema).max(256),
});
type Probe = z.infer<typeof probeSchema>;
function seconds(value?: string) {
  if (!value) return undefined;
  const n = value.includes(":")
    ? value.split(":").reduce((a, v) => a * 60 + Number(v), 0)
    : Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
export function parseProbe(text: string): Probe {
  try {
    return probeSchema.parse(JSON.parse(text));
  } catch {
    throw new Error("Media inspection returned malformed metadata");
  }
}
export async function probe(
  file: string,
  signal?: AbortSignal,
): Promise<Probe> {
  const output = await runProcess(
    "ffprobe",
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file",
      "-show_format",
      "-show_streams",
      "-of",
      "json",
      file,
    ],
    { signal },
  );
  return parseProbe(output);
}
export async function fingerprint(
  file: string,
  settings: Settings,
  identity = "",
) {
  const info = await stat(file);
  if (!info.isFile()) throw new Error("Media path is not a regular file");
  const policy = [
    settings.requiredLanguages,
    settings.allowDescriptive,
    settings.requireMainProgram,
  ];
  return createHash("sha256")
    .update(
      JSON.stringify([file, info.size, info.mtimeMs, identity, policy, 2]),
    )
    .digest("hex");
}
export async function scanFile(
  file: string,
  signal?: AbortSignal,
): Promise<ScanResult> {
  const settings = getSettings();
  const before = await fingerprint(file, settings);
  const data = await probe(file, signal);
  const duration = seconds(data.format?.duration);
  const tracks: AudioTrack[] = data.streams
    .filter((s) => s.codec_type === "audio")
    .map((s) => ({
      index: s.index,
      codec: s.codec_name || "unknown",
      language: normalizeLanguage(s.tags?.language),
      title: s.tags?.title,
      duration: seconds(s.duration || s.tags?.DURATION || s.tags?.duration),
      bitrate: Number(s.bit_rate) || undefined,
      channels: s.channels,
      layout: s.channel_layout,
      isDefault: Boolean(s.disposition?.default),
      isForced: Boolean(s.disposition?.forced),
      isCommentary: isCommentary(s.tags?.title, s.disposition),
      isDescriptive: isDescriptive(s.tags?.title, s.disposition),
    }));
  if ((await fingerprint(file, settings)) !== before)
    throw new Error(
      "Media changed during inspection; retry after import completes",
    );
  return {
    path: file,
    duration,
    tracks,
    ...decideAudio(duration, tracks, settings),
    scannedAt: new Date().toISOString(),
    fingerprint: before,
  };
}
