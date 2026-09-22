import {
  createHash,
  randomBytes,
  timingSafeEqual,
  randomUUID,
} from "node:crypto";
import { z } from "zod";
import { raw, audit, jobQueue } from "./store";
import { boundedBody } from "./http";
import { validAbsolute } from "./security";
type Source = "sonarr" | "radarr";
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function rotateWebhookToken(source: Source) {
  const token = randomBytes(32).toString("base64url");
  raw()
    .prepare(
      "INSERT INTO webhook_tokens VALUES(?,?) ON CONFLICT(source) DO UPDATE SET token_hash=excluded.token_hash",
    )
    .run(source, digest(token));
  audit("webhook", `${source} webhook token rotated`, "admin");
  return token;
}
export function webhookConfigured(source: Source) {
  return Boolean(
    raw().prepare("SELECT 1 FROM webhook_tokens WHERE source=?").get(source),
  );
}
function authorized(source: Source, header: string | null) {
  const row = raw()
    .prepare("SELECT token_hash FROM webhook_tokens WHERE source=?")
    .get(source) as { token_hash: string } | undefined;
  if (!row || !header?.startsWith("Bearer ") || header.length > 200)
    return false;
  return timingSafeEqual(
    Buffer.from(row.token_hash, "hex"),
    Buffer.from(digest(header.slice(7)), "hex"),
  );
}
const file = z.object({
  id: z.number().int().positive(),
  path: z.string().min(1).max(4096),
});
const entity = z.object({ id: z.number().int().positive() });
const event = z.object({
  eventType: z.literal("Download"),
  downloadId: z.string().max(512).optional(),
  movie: entity.optional(),
  series: entity.optional(),
  episodes: z.array(entity).max(100).optional(),
  movieFile: file.optional(),
  episodeFile: file.optional(),
});
export async function receiveWebhook(source: Source, request: Request) {
  if (!authorized(source, request.headers.get("authorization")))
    return Response.json(
      { error: "Invalid webhook credentials" },
      { status: 401 },
    );
  let payload: unknown;
  try {
    payload = JSON.parse(
      new TextDecoder().decode(await boundedBody(request, 256 * 1024)),
    );
  } catch {
    return Response.json(
      { error: "Invalid or oversized JSON payload" },
      { status: 400 },
    );
  }
  if (z.object({ eventType: z.literal("Test") }).safeParse(payload).success)
    return Response.json({ accepted: true, test: true });
  const parsed = event.safeParse(payload);
  if (!parsed.success)
    return Response.json(
      { error: "Unsupported import event" },
      { status: 400 },
    );
  const data = parsed.data;
  const media = source === "sonarr" ? data.episodeFile : data.movieFile;
  const title = source === "sonarr" ? data.series : data.movie;
  if (!media || !title)
    return Response.json(
      { error: "Import identity and file are required" },
      { status: 400 },
    );
  try {
    validAbsolute(media.path);
  } catch {
    return Response.json({ error: "Invalid imported path" }, { status: 400 });
  }
  const identity = digest(
    JSON.stringify([
      source,
      data.eventType,
      data.downloadId || "",
      title.id,
      media.id,
      media.path,
    ]),
  );
  // Receipt and queue entry commit together: a crash cannot acknowledge an unqueued import.
  const result = raw()
    .transaction(() => {
      if (
        raw()
          .prepare("SELECT 1 FROM webhook_receipts WHERE digest=?")
          .get(identity)
      )
        return { accepted: true, deduplicated: true };
      const job = jobQueue.enqueue("scan-file", {
        source,
        arrPath: media.path,
        entityId: source === "sonarr" ? data.episodes?.[0]?.id : title.id,
        seriesId: source === "sonarr" ? title.id : undefined,
        fileId: media.id,
        downloadId: data.downloadId,
      });
      raw()
        .prepare("INSERT INTO webhook_receipts VALUES(?,?,?)")
        .run(randomUUID(), identity, new Date().toISOString());
      audit("webhook", `${source} import queued as ${job.id}`);
      return { accepted: true, queued: true, jobId: job.id };
    })
    .immediate();
  return Response.json(result, { status: 202 });
}
