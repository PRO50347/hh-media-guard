import { requireAdmin } from "@/lib/auth";
import { resolveAttention } from "@/lib/attention";
import { jsonBody } from "@/lib/http";
import { z } from "zod";
export async function POST(request: Request) {
  try {
    const actor = await requireAdmin(true);
    const input = z
      .object({
        id: z.string().uuid(),
        action: z.enum(["rescan", "retry", "reset", "accept", "ignore"]),
      })
      .parse(await jsonBody(request));
    resolveAttention(input.id, input.action, actor.username);
    return Response.json({ ok: true });
  } catch {
    return Response.json(
      {
        error:
          "Action rejected. Correct mappings and retry a library audit if no file can be identified.",
      },
      { status: 400 },
    );
  }
}
