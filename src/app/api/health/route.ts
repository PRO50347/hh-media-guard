import { NextResponse } from "next/server";
import { getSettings } from "@/lib/store";
import metadata from "../../../../package.json";
import { runProcess } from "@/lib/process";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const settings = getSettings();
    await runProcess("ffprobe", ["-version"], {
      timeoutMs: 2000,
      maxBytes: 65536,
    });
    return NextResponse.json({
      ok: true,
      version: process.env.APP_VERSION || metadata.version,
      mode: settings.safetyMode,
      destructiveActions:
        process.env.ALLOW_DESTRUCTIVE_ACTIONS === "true" &&
        settings.safetyMode !== "monitor",
      database: "ok",
      ffprobe: "ok",
    });
  } catch {
    return NextResponse.json(
      { ok: false, version: process.env.APP_VERSION || metadata.version },
      { status: 503 },
    );
  }
}
