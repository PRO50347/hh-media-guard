import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getSettings, saveSettings } from "@/lib/store";
import { settingsSchema } from "@/lib/settings-schema";
import { jsonBody } from "@/lib/http";

export async function GET() {
  try {
    await requireAdmin();
    return NextResponse.json(getSettings());
  } catch {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 },
    );
  }
}
export async function POST(request: Request) {
  try {
    await requireAdmin(true);
    // Read current settings after the asynchronous body read. Otherwise a
    // concurrent save can be overwritten by this request's stale snapshot.
    const patch = Object(await jsonBody(request));
    const settings = settingsSchema.parse({ ...getSettings(), ...patch });
    if (
      settings.safetyMode !== "monitor" &&
      process.env.ALLOW_DESTRUCTIVE_ACTIONS !== "true"
    )
      throw new Error(
        "Set ALLOW_DESTRUCTIVE_ACTIONS=true before enabling this mode",
      );
    return NextResponse.json(saveSettings(settings));
  } catch {
    return NextResponse.json(
      {
        error:
          "Settings rejected. Check field values and the destructive-actions environment switch.",
      },
      { status: 400 },
    );
  }
}
