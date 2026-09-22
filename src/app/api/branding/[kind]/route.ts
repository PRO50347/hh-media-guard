import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import {
  assetKind,
  MAX_IMAGE_BYTES,
  readBranding,
  removeBranding,
  saveBranding,
} from "@/lib/branding";
import { boundedBody } from "@/lib/http";

type Context = { params: Promise<{ kind: string }> };
export async function GET(_: Request, { params }: Context) {
  try {
    const bytes = await readBranding(assetKind.parse((await params).kind));
    if (!bytes) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "image/png",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "no-cache",
      },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}
export async function PUT(request: Request, { params }: Context) {
  try {
    await requireAdmin(true);
    const result = await saveBranding(
      assetKind.parse((await params).kind),
      await boundedBody(request, MAX_IMAGE_BYTES),
      request.headers.get("content-type") || "",
    );
    return NextResponse.json(result);
  } catch {
    return NextResponse.json(
      {
        error:
          "Upload rejected. Use a valid PNG/JPEG/WebP up to 2 MiB and 4096 × 4096 pixels.",
      },
      { status: 400 },
    );
  }
}
export async function DELETE(_: Request, { params }: Context) {
  try {
    await requireAdmin(true);
    removeBranding(assetKind.parse((await params).kind));
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Request rejected" }, { status: 403 });
  }
}
