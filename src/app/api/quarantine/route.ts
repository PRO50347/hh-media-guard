import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { jsonBody } from "@/lib/http";
import { cleanupVerifiedQuarantine } from "@/lib/quarantine-cleanup";
import { restoreFromQuarantine } from "@/lib/quarantine";
export async function POST(request: Request) {
  try {
    await requireAdmin(true);
    const { id } = z
      .object({ id: z.string().uuid() })
      .parse(await jsonBody(request));
    await restoreFromQuarantine(id);
    return Response.json({ ok: true });
  } catch {
    return Response.json(
      {
        error:
          "Restore refused or incomplete. Check safety mode, file collisions, mappings, and operation evidence.",
      },
      { status: 400 },
    );
  }
}

export async function DELETE(request: Request) {
  try {
    await requireAdmin(true);
    const { id } = z
      .object({ id: z.string().uuid() })
      .parse(await jsonBody(request));
    await cleanupVerifiedQuarantine(id);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Cleanup refused; quarantine retained",
      },
      { status: 400 },
    );
  }
}
