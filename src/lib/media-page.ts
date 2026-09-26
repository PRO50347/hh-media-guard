import { raw } from "./store";
import { withRemediation } from "./manual-remediation";

export const mediaStatuses = [
  "pass",
  "fail",
  "needs-analysis",
  "needs-attention",
  "pending",
  "quarantined",
];
export type PageSearchParams = Promise<
  Record<string, string | string[] | undefined>
>;
export async function mediaParams(input: PageSearchParams) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await input)) {
    if (typeof value === "string") params.set(key, value);
    else if (value?.[0]) params.set(key, value[0]);
  }
  return params;
}

export function mediaPage(
  params: URLSearchParams,
  source?: "sonarr" | "radarr",
) {
  const status = mediaStatuses.includes(params.get("status") || "")
    ? params.get("status")!
    : "";
  const search = (params.get("q") || "").slice(0, 256);
  const where: string[] = [];
  const args: string[] = [];
  if (source) {
    where.push("source=?");
    args.push(source);
  }
  if (status) {
    where.push(
      ["pass", "fail", "needs-analysis"].includes(status)
        ? "decision=?"
        : "action_state=?",
    );
    args.push(status);
  }
  if (search) {
    where.push("instr(lower(title || ' ' || path), lower(?)) > 0");
    args.push(search);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const { total } = raw()
    .prepare(`SELECT COUNT(*) AS total FROM media_items ${clause}`)
    .get(...args) as { total: number };
  const pages = Math.max(1, Math.ceil(total / 25));
  const requested = Number(params.get("page"));
  const page = Number.isSafeInteger(requested)
    ? Math.max(1, Math.min(pages, requested))
    : 1;
  const items = raw()
    .prepare(
      `SELECT id,source,arr_id,title,path,decision,last_scanned_at,action_state,details
    FROM media_items ${clause} ORDER BY title COLLATE NOCASE,id LIMIT 25 OFFSET ?`,
    )
    .all(...args, (page - 1) * 25) as {
    id: string;
    source: string;
    arr_id: number;
    title: string;
    path: string;
    decision?: string;
    last_scanned_at?: string;
    action_state: string;
    details?: string;
  }[];
  return { items: withRemediation(items), total, page, pages, status, search };
}
