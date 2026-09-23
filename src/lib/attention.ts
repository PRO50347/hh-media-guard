import { raw, audit, jobQueue } from "./store";
import { resetReplacement } from "./retries";
import type { MediaIdentity } from "./remediation";

type Action = "rescan" | "retry" | "reset" | "accept" | "ignore";
/** Overrides preserve original evidence and never erase the operation journal. */
export function resolveAttention(id: string, action: Action, actor: string) {
  return raw()
    .transaction(() => {
      const row = raw()
        .prepare("SELECT subject,evidence FROM attention WHERE id=?")
        .get(id) as { subject: string; evidence: string } | undefined;
      if (!row) throw new Error("Attention item not found");
      const media = raw()
        .prepare("SELECT path,details FROM media_items WHERE id=?")
        .get(row.subject) as { path: string; details?: string } | undefined;
      const operation = raw()
        .prepare("SELECT evidence FROM operations WHERE id=?")
        .get(row.subject) as { evidence: string } | undefined;
      const evidence = JSON.parse(operation?.evidence || row.evidence) as {
        path?: string;
        scan?: { path: string };
        identity?: MediaIdentity;
        item?: MediaIdentity;
      };
      const identity: MediaIdentity | undefined =
        evidence.identity ||
        evidence.item ||
        (media?.details ? JSON.parse(media.details) : undefined);
      const title = identity && `${identity.source}:${identity.entityId}`;
      if (action === "reset") {
        if (!title) throw new Error("No Arr title identity available");
        resetReplacement(title, actor);
      } else if (action === "retry" || action === "rescan") {
        if (identity) {
          jobQueue.enqueue("scan-library", {
            source: identity.source,
            entityId: identity.entityId,
            ...(identity.seriesId ? { seriesId: identity.seriesId } : {}),
            force: true,
          });
        } else {
          const path = media?.path || evidence.scan?.path || evidence.path;
          if (!path)
            throw new Error("Correct the mapping and restart a library audit");
          jobQueue.enqueue("scan-file", { path, force: true });
        }
      } else {
        if (title) {
          raw()
            .prepare(
              "INSERT INTO retry_titles VALUES(?,0,0,1) ON CONFLICT(identity) DO UPDATE SET ignored=1",
            )
            .run(title);
        }
        raw()
          .prepare("UPDATE attention SET state=? WHERE id=?")
          .run(action === "accept" ? "accepted" : "ignored", id);
      }
      audit("override", `${action}: attention ${id}`, actor);
    })
    .immediate();
}
