import { NextResponse } from "next/server";
import { z } from "zod";
import { addMapping, deleteMapping, listMappings } from "@/lib/store";
import { requireAdmin } from "@/lib/auth";
import { raw, audit } from "@/lib/store";
import { validateMappingRoot, validAbsolute } from "@/lib/security";
import { jsonBody } from "@/lib/http";
const schema = z.object({
  source: z.enum(["sonarr", "radarr", "generic"]),
  arrPath: z.string().startsWith("/").max(1024),
  containerPath: z.string().startsWith("/").max(1024),
  mediaType: z.enum(["tv", "movies", "anime", "kids", "other"]),
  enabled: z.boolean(),
});
export async function GET() {
  try {
    await requireAdmin();
    return NextResponse.json(listMappings());
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
    const data = schema.parse(await jsonBody(request));
    data.arrPath = validAbsolute(data.arrPath);
    data.containerPath = await validateMappingRoot(data.containerPath);
    if (new URL(request.url).searchParams.get("test") === "true")
      return NextResponse.json({ ok: true, path: data.containerPath });
    return NextResponse.json(addMapping(data), { status: 201 });
  } catch {
    return NextResponse.json(
      {
        error:
          "Mapping rejected. Confirm the path exists within MEDIA_ROOTS and contains no escaping symlinks.",
      },
      { status: 400 },
    );
  }
}
export async function PUT(request: Request) {
  try {
    await requireAdmin(true);
    const input = schema
      .extend({ id: z.string().uuid() })
      .parse(await jsonBody(request));
    input.arrPath = validAbsolute(input.arrPath);
    input.containerPath = await validateMappingRoot(input.containerPath);
    raw()
      .prepare(
        "UPDATE mappings SET source=?,arr_path=?,container_path=?,media_type=?,enabled=? WHERE id=?",
      )
      .run(
        input.source,
        input.arrPath,
        input.containerPath,
        input.mediaType,
        Number(input.enabled),
        input.id,
      );
    audit("mapping", "Mapping updated", "admin");
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { error: "Mapping update rejected" },
      { status: 400 },
    );
  }
}
export async function DELETE(request: Request) {
  try {
    await requireAdmin(true);
    const id = new URL(request.url).searchParams.get("id");
    if (!id)
      return NextResponse.json(
        { error: "Mapping id required" },
        { status: 400 },
      );
    deleteMapping(id);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Request rejected" }, { status: 403 });
  }
}
