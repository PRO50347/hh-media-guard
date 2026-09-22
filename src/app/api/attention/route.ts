import { requireAdmin } from "@/lib/auth";
import { raw, audit, jobQueue } from "@/lib/store";
import { jsonBody } from "@/lib/http";
import { z } from "zod";
export async function POST(request: Request) {
  try {
    const actor = await requireAdmin(true);
    const input = z
      .object({
        id: z.string().uuid(),
        action: z.enum(["rescan", "accept", "ignore"]),
      })
      .parse(await jsonBody(request));
    const row = raw()
      .prepare("SELECT * FROM attention WHERE id=?")
      .get(input.id) as { subject: string; evidence: string } | undefined;
    if (!row) throw new Error("Not found");
    if (input.action === "rescan") {
      const media = raw()
        .prepare("SELECT path FROM media_items WHERE id=?")
        .get(row.subject) as { path: string } | undefined;
      const evidence = JSON.parse(row.evidence) as {
        path?: string;
        scan?: { path?: string };
      };
      const path = media?.path || evidence.scan?.path || evidence.path;
      if (!path)
        throw new Error("Correct the mapping and restart a library audit");
      jobQueue.enqueue("scan-file", { path, force: true });
    } else {
      raw()
        .prepare("UPDATE attention SET state=? WHERE id=?")
        .run(input.action === "accept" ? "accepted" : "ignored", input.id);
    }
    audit("override", `${input.action}: attention ${input.id}`, actor.username);
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
