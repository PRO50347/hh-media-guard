import { SafeError, safeMessage } from "@/lib/safe-error";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ArrClient } from "@/lib/clients";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import {
  integration,
  integrationKey,
  integrationResult,
  saveIntegration,
} from "@/lib/store";
import { requireAdmin } from "@/lib/auth";
import { serviceUrl } from "@/lib/arr-transport";
import { jsonBody } from "@/lib/http";
import { raw, audit } from "@/lib/store";

const schema = z.object({
  enabled: z.boolean(),
  url: z.string().url().max(2048).optional(),
  apiKey: z.string().min(1).max(512).optional(),
});
function id(value: string) {
  if (value !== "sonarr" && value !== "radarr")
    throw new Error("Unknown integration");
  return value;
}
export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin();
    return NextResponse.json(integration(id((await params).id)));
  } catch {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 },
    );
  }
}
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin(true);
    const data = schema.parse(await jsonBody(request));
    const name = id((await params).id);
    if (data.url) serviceUrl(data.url);
    if (data.enabled && (!data.url || (!data.apiKey && !integrationKey(name))))
      throw new Error("Incomplete configuration");
    saveIntegration(
      name,
      data.enabled,
      data.url || "",
      data.apiKey ? encryptSecret(data.apiKey) : undefined,
    );
    return NextResponse.json(integration(name));
  } catch {
    return NextResponse.json(
      {
        error:
          "Configuration rejected. Check the URL, API key, and ENCRYPTION_KEY configuration.",
      },
      { status: 400 },
    );
  }
}
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  // An unauthorized connection test must not alter persisted integration state.
  try {
    await requireAdmin(true);
  } catch {
    return NextResponse.json({ error: "Request rejected" }, { status: 403 });
  }
  let testedSaved: "sonarr" | "radarr" | undefined;
  try {
    const name = id((await params).id);
    const data = request.headers
      .get("content-type")
      ?.includes("application/json")
      ? z
          .object({
            url: z.string().max(2048).optional(),
            apiKey: z.string().min(1).max(512).optional(),
          })
          .parse(await jsonBody(request))
      : {};
    const config = integration(name);
    const stored = integrationKey(name);
    const url = data.url ?? config.url;
    if (data.apiKey === undefined && url === config.url) testedSaved = name;
    if (!url)
      throw new SafeError("arr.url", "Enter the server URL before testing.");
    serviceUrl(url);
    const key = data.apiKey ?? (stored ? decryptSecret(stored) : undefined);
    if (!key)
      throw new SafeError("arr.key", "Enter an API key before testing.");
    const result = await new ArrClient(url, key).testConnection(name);
    // Testing unsaved input neither saves credentials nor rewrites saved status.
    if (testedSaved) integrationResult(testedSaved, result.version);
    return NextResponse.json({
      ok: true,
      version: result.version,
      service: name,
    });
  } catch (error) {
    const message = safeMessage(
      error,
      "Connection test rejected; check the URL and API key input.",
    );
    try {
      if (testedSaved) integrationResult(testedSaved, undefined, message);
    } catch {
      /* A status-write failure must not expose database exceptions. */
    }
    return NextResponse.json(
      {
        error: message,
        code: error instanceof SafeError ? error.code : "arr.input",
      },
      { status: 400 },
    );
  }
}

export async function DELETE(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin(true);
    const name = id((await params).id);
    raw().prepare("DELETE FROM integrations WHERE id=?").run(name);
    audit("integration", `${name} configuration removed`, "admin");
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Request rejected" }, { status: 403 });
  }
}
