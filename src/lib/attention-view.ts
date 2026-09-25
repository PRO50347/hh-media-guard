export type AttentionItem = {
  id: string;
  subject: string;
  reason: string;
  evidence: string;
  state: string;
  media_title?: string | null;
  media_source?: string | null;
  related_evidence?: string | null;
};

export const reasonOptions = [
  ["all", "All reasons"],
  ["wrong-language", "Wrong language"],
  ["needs-analysis", "Needs analysis / unknown language"],
  ["scanner-failure", "Scanner failure"],
  ["job-failure", "Job failure / worker recovery"],
  ["other", "Other issues"],
] as const;

export function evidenceObject(value?: string | null): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function attentionDetails(item: AttentionItem) {
  const evidence = evidenceObject(item.evidence);
  const related = evidenceObject(item.related_evidence);
  const records = [
    evidence.item,
    evidence.identity,
    evidence,
    related.item,
    related.identity,
    related,
  ].filter(
    (value): value is Record<string, unknown> =>
      !!value && typeof value === "object",
  );
  const source =
    item.media_source ||
    records.find(
      (value) => value.source === "sonarr" || value.source === "radarr",
    )?.source;
  const title =
    item.media_title ||
    records.find((value) => typeof value.title === "string" && value.title)
      ?.title;
  const category =
    (
      {
        "missing required language": "wrong-language",
        "unknown language": "needs-analysis",
        "scanner failure": "scanner-failure",
        "worker recovery or job failure": "job-failure",
      } as Record<string, string>
    )[item.reason] || "other";
  return {
    title: typeof title === "string" ? title : item.subject,
    source:
      source === "sonarr"
        ? "Sonarr"
        : source === "radarr"
          ? "Radarr"
          : "Source unavailable",
    media:
      source === "sonarr" ? "tv" : source === "radarr" ? "movies" : "other",
    category,
  };
}

export function attentionFilters(params: Pick<URLSearchParams, "get">) {
  const valid = (key: string, values: readonly string[], fallback: string) => {
    const value = params.get(key) || fallback;
    return values.includes(value) ? value : fallback;
  };
  return {
    media: valid("media", ["all", "movies", "tv"], "all"),
    reason: valid(
      "reason",
      reasonOptions.map(([value]) => value),
      "all",
    ),
    status: valid("status", ["all", "open", "accepted", "ignored"], "open"),
  };
}

export function filterAttention(
  items: AttentionItem[],
  filters: ReturnType<typeof attentionFilters>,
) {
  return items.filter((item) => {
    const details = attentionDetails(item);
    return (
      (filters.status === "all" || item.state === filters.status) &&
      (filters.media === "all" || details.media === filters.media) &&
      (filters.reason === "all" || details.category === filters.reason)
    );
  });
}

export function attentionHref(
  params: { toString(): string },
  key: string,
  value: string,
) {
  const next = new URLSearchParams(params.toString());
  next.set(key, value);
  if (key !== "page") next.delete("page");
  return `/attention?${next}`;
}

export function attentionPage(total: number, value: string | null) {
  const pages = Math.max(1, Math.ceil(total / 25));
  const requested = Number(value);
  const page = Number.isSafeInteger(requested)
    ? Math.min(pages, Math.max(1, requested))
    : 1;
  return { page, pages };
}

export function attentionEvidence(value: string) {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
