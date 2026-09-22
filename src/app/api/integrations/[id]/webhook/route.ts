import { requireAdmin } from "@/lib/auth";
import { rotateWebhookToken, webhookConfigured } from "@/lib/webhooks";
import { z } from "zod";
type Context = { params: Promise<{ id: string }> };
export async function GET(_: Request, { params }: Context) {
  try {
    await requireAdmin();
    return Response.json({
      configured: webhookConfigured(
        z.enum(["sonarr", "radarr"]).parse((await params).id),
      ),
    });
  } catch {
    return Response.json({ error: "Request rejected" }, { status: 403 });
  }
}
export async function POST(_: Request, { params }: Context) {
  try {
    await requireAdmin(true);
    return Response.json(
      {
        token: rotateWebhookToken(
          z.enum(["sonarr", "radarr"]).parse((await params).id),
        ),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "Request rejected" }, { status: 403 });
  }
}
