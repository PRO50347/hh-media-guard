import {
  attentionFilters,
  attentionPage,
  type AttentionItem,
} from "./attention-view";

type QueueDatabase = {
  prepare(sql: string): {
    all(...params: (string | number)[]): unknown[];
  };
};

// Only grouped counts and one page of full records leave the database.
const joined = `FROM attention a
  LEFT JOIN media_items m ON m.id = a.subject
  LEFT JOIN operations o ON o.id = a.subject
  LEFT JOIN jobs j ON j.id = a.subject`;
const jsonSource = (column: string, path: string) => {
  const value = `json_extract(CASE WHEN json_valid(${column}) THEN ${column} ELSE '{}' END, '${path}.source')`;
  return `CASE WHEN ${value} IN ('sonarr', 'radarr') THEN ${value} END`;
};
const source = `COALESCE(NULLIF(m.source, ''), ${[
  "a.evidence",
  "COALESCE(o.evidence, j.payload)",
]
  .flatMap((column) =>
    ["$.item", "$.identity", "$"].map((path) => jsonSource(column, path)),
  )
  .join(", ")})`;
const classified = `WITH queue AS (
  SELECT a.id, a.state, a.created_at,
    CASE ${source} WHEN 'sonarr' THEN 'tv' WHEN 'radarr' THEN 'movies' ELSE 'other' END AS media,
    CASE a.reason
      WHEN 'missing required language' THEN 'wrong-language'
      WHEN 'unknown language' THEN 'needs-analysis'
      WHEN 'scanner failure' THEN 'scanner-failure'
      WHEN 'worker recovery or job failure' THEN 'job-failure'
      ELSE 'other' END AS category
  ${joined}
)`;

export function attentionQueue(db: QueueDatabase, params: URLSearchParams) {
  const filters = attentionFilters(params);
  const groups = db
    .prepare(
      `${classified}
    SELECT state, media, category, COUNT(*) AS count FROM queue GROUP BY state, media, category
  `,
    )
    .all() as {
    state: string;
    media: string;
    category: string;
    count: number;
  }[];
  const summary = { open: 0, ignored: 0, accepted: 0 };
  const mediaCounts = { all: 0, movies: 0, tv: 0 };
  let total = 0;
  for (const group of groups) {
    if (
      group.state === "open" ||
      group.state === "ignored" ||
      group.state === "accepted"
    )
      summary[group.state] += group.count;
    if (
      (filters.status === "all" || group.state === filters.status) &&
      (filters.reason === "all" || group.category === filters.reason)
    ) {
      mediaCounts.all += group.count;
      if (group.media === "movies" || group.media === "tv")
        mediaCounts[group.media] += group.count;
      if (filters.media === "all" || group.media === filters.media)
        total += group.count;
    }
  }
  const pagination = attentionPage(total, params.get("page"));
  const items = db
    .prepare(
      `${classified}, selected AS (
    SELECT id FROM queue
    WHERE (? = 'all' OR state = ?) AND (? = 'all' OR category = ?) AND (? = 'all' OR media = ?)
    ORDER BY CASE WHEN state = 'open' THEN 0 ELSE 1 END, created_at DESC, id
    LIMIT 25 OFFSET ?
  )
  SELECT a.*, m.title AS media_title, m.source AS media_source,
    COALESCE(o.evidence, j.payload) AS related_evidence
  ${joined}
  WHERE a.id IN (SELECT id FROM selected)
  ORDER BY CASE WHEN a.state = 'open' THEN 0 ELSE 1 END, a.created_at DESC, a.id
  `,
    )
    .all(
      filters.status,
      filters.status,
      filters.reason,
      filters.reason,
      filters.media,
      filters.media,
      (pagination.page - 1) * 25,
    ) as AttentionItem[];
  return { items, summary, mediaCounts, total, ...pagination };
}
