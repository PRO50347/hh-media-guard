import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { acceptWebhook, audit, createJob } from "@/lib/store";

const MAX_BODY = 256 * 1024;

function importedPath(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const event = payload as {
    movieFile?: { path?: unknown };
    episodeFile?: { path?: unknown };
  };
  if (typeof event.movieFile?.path === "string") return event.movieFile.path;
  if (typeof event.episodeFile?.path === "string")
    return event.episodeFile.path;
  return undefined;
}

export async function POST(request: Request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY)
    return NextResponse.json(
      { error: "Webhook body too large" },
      { status: 413 },
    );
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret)
    return NextResponse.json(
      { error: "Webhooks are not configured" },
      { status: 403 },
    );
  const signature = request.headers.get("x-media-guard-signature") || "";
  const expected = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  if (
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  )
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const digest = createHash("sha256").update(raw).digest("hex");
  if (!acceptWebhook(digest))
    return NextResponse.json({ accepted: true, deduplicated: true });
  const path = importedPath(payload);
  if (!path) {
    audit("webhook", "Authenticated webhook had no imported-file path");
    return NextResponse.json({ accepted: true, queued: false });
  }
  const job = createJob("scan-file", { path, source: "webhook" });
  audit("webhook", `Queued imported-media scan ${job.id}`);
  return NextResponse.json({ accepted: true, queued: true, jobId: job.id });
}
