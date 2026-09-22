import { NextResponse } from "next/server";
import { getSettings } from "@/lib/store";
import metadata from "../../../../package.json";
export const dynamic = "force-dynamic";
export async function GET() {
  const settings = getSettings();
  return NextResponse.json({
    ok: true,
    version: process.env.APP_VERSION || metadata.version,
    mode: settings.safetyMode,
    destructiveActions:
      process.env.ALLOW_DESTRUCTIVE_ACTIONS === "true" &&
      settings.safetyMode !== "monitor",
    database: "ok",
    ffprobe: "configured",
  });
}
