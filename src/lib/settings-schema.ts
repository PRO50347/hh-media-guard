import { z } from "zod";
const link = z.object({
  name: z.string().min(1).max(80),
  url: z
    .string()
    .url()
    .refine((v) => /^https?:\/\//.test(v)),
  icon: z.string().max(8).default("↗"),
  enabled: z.boolean(),
});
export const settingsSchema = z.object({
  appName: z.string().min(1).max(80),
  suiteName: z.string().max(80),
  shortName: z.string().min(1).max(40),
  accent: z.string().regex(/^#[a-fA-F0-9]{6}$/),
  theme: z.enum(["dark", "light", "system"]),
  showSuite: z.boolean(),
  requiredLanguages: z
    .array(z.string().regex(/^[a-z]{2,3}$/))
    .min(1)
    .max(10),
  allowDescriptive: z.boolean(),
  ignoreCommentary: z.literal(true),
  requireMainProgram: z.literal(true),
  unknownBehavior: z.literal("needs-analysis"),
  safetyMode: z.enum(["monitor", "manual", "quarantine", "automatic"]),
  retryLimit: z.number().int().min(1).max(10),
  retryCooldownMinutes: z.number().int().min(1).max(10080),
  quarantinePath: z.string().max(1024).optional(),
  setupComplete: z.boolean(),
  // Retired setting: reject writes rather than silently accepting an override.
  iconUrl: z.never().optional(),
  suiteLinks: z.array(link).max(20).optional(),
  scanIntervalHours: z.number().int().min(0).max(720).optional(),
});
