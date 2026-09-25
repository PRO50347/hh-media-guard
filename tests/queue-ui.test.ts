import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  attentionEvidence,
  attentionDetails,
  attentionFilters,
  attentionHref,
  attentionPage,
  filterAttention,
  type AttentionItem,
} from "../src/lib/attention-view";

const navigation = vi.hoisted(() => ({
  query: "",
  replace: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(navigation.query),
  useRouter: () => navigation,
  usePathname: () => "/library",
  redirect: vi.fn(),
}));
vi.mock("../src/lib/auth", () => ({
  currentSession: async () => ({ id: "admin" }),
}));
vi.mock("../src/lib/store", () => ({
  getSettings: () => ({ setupComplete: true, appName: "Media Guard" }),
  stats: () => ({ total: 8, pass: 5, fail: 2, analysis: 1 }),
  recentEvents: () => [],
  raw: () => ({ prepare: () => ({ get: () => ({ count: 3 }) }) }),
}));
import Dashboard from "../src/app/page";
import { AttentionView } from "../src/components/AttentionView";
import { MediaView } from "../src/components/MediaView";

const item = (
  id: string,
  source: string,
  reason: string,
  state = "open",
): AttentionItem => ({
  id,
  subject: `subject-${id}`,
  reason,
  state,
  evidence: JSON.stringify({ item: { source, title: `Title ${id}` } }),
});
const items = [
  item("movie", "radarr", "missing required language"),
  item("tv", "sonarr", "missing required language"),
  item("unknown", "sonarr", "unknown language"),
  item("scanner", "radarr", "scanner failure"),
  item("job", "sonarr", "worker recovery or job failure"),
  item("ignored", "radarr", "missing required language", "ignored"),
  item("other", "", "unmapped path"),
];

describe("dashboard and work queue navigation", () => {
  it("renders all six dashboard cards as native links with useful destinations", async () => {
    const html = renderToStaticMarkup(await Dashboard());
    for (const [label, href] of [
      ["Total scanned", "/library"],
      ["Verified", "/library?status=pass"],
      ["Wrong language", "/attention?reason=wrong-language&amp;status=open"],
      ["Needs analysis", "/attention?reason=needs-analysis&amp;status=open"],
      ["Needs attention", "/attention?status=open"],
      ["Quarantined", "/quarantine"],
    ])
      expect(html).toContain(`href="${href}"><span>${label}</span>`);
    expect(html.match(/class="metric metric-link"/g)).toHaveLength(6);
  });

  it("combines media, reason and status filters and defaults to open", () => {
    const select = (query: string) =>
      filterAttention(items, attentionFilters(new URLSearchParams(query))).map(
        (row) => row.id,
      );
    expect(select("reason=wrong-language")).toEqual(["movie", "tv"]);
    expect(select("reason=wrong-language&media=movies")).toEqual(["movie"]);
    expect(select("reason=wrong-language&media=tv")).toEqual(["tv"]);
    expect(select("reason=needs-analysis")).toEqual(["unknown"]);
    expect(select("reason=scanner-failure")).toEqual(["scanner"]);
    expect(select("reason=job-failure")).toEqual(["job"]);
    expect(select("status=ignored")).toEqual(["ignored"]);
    expect(select("status=all")).toHaveLength(7);
    expect(select("reason=other")).toEqual(["other"]);
    expect(select("reason=invalid&media=invalid&status=invalid")).toHaveLength(
      6,
    );
  });

  it("preserves other filters in links and resets pagination when filters change", () => {
    const params = new URLSearchParams(
      "reason=wrong-language&status=ignored&page=4",
    );
    expect(attentionHref(params, "media", "movies")).toBe(
      "/attention?reason=wrong-language&status=ignored&media=movies",
    );
    expect(attentionHref(params, "page", "2")).toContain(
      "status=ignored&page=2",
    );
  });

  it("handles nested identities, joined metadata, job payloads and malformed evidence", () => {
    expect(
      attentionDetails({
        ...items[0],
        media_title: "Joined title",
        media_source: "sonarr",
      }),
    ).toMatchObject({ title: "Joined title", media: "tv", source: "Sonarr" });
    expect(
      attentionDetails({
        ...items[0],
        evidence: '{"identity":{"source":"radarr"}}',
      }).media,
    ).toBe("movies");
    expect(
      attentionDetails({
        ...items[0],
        evidence: "null",
        related_evidence: '{"source":"sonarr"}',
      }).source,
    ).toBe("Sonarr");
    expect(attentionEvidence("broken")).toBe("broken");
    expect(attentionEvidence('{"source":"sonarr"}')).toContain(
      '\n  "source": "sonarr"\n',
    );
    expect(attentionDetails({ ...items[0], evidence: "broken" })).toMatchObject(
      { title: "subject-movie", media: "other" },
    );
  });

  it("paginates and clamps invalid or stale page numbers", () => {
    expect(attentionPage(51, "2")).toEqual({ page: 2, pages: 3 });
    expect(attentionPage(51, "999")).toMatchObject({ page: 3, pages: 3 });
    expect(attentionPage(51, "NaN").page).toBe(1);
    expect(attentionPage(0, "-2")).toEqual({ page: 1, pages: 1 });
  });

  it("renders the linked queue selection, counts, labels and all existing actions", () => {
    navigation.query = "reason=wrong-language&media=movies";
    const html = renderToStaticMarkup(
      createElement(AttentionView, {
        queue: {
          items: filterAttention(
            items,
            attentionFilters(new URLSearchParams(navigation.query)),
          ),
          summary: { open: 3889, ignored: 12, accepted: 5 },
          mediaCounts: { all: 3000, movies: 2000, tv: 1000 },
          total: 2000,
          page: 1,
          pages: 80,
        },
      }),
    );
    expect(html).toContain("Title movie");
    expect(html).not.toContain("Title tv");
    expect(html).not.toContain("Title ignored");
    expect(html).toContain("Radarr");
    expect(html).toContain("missing required language");
    expect(html).toContain("2000 matching items");
    expect(html).toContain("3889 open");
    expect(html).toContain("Movies (2000)");
    expect(html).toContain("TV Shows (1000)");
    expect(html).not.toContain("500");
    expect(html).toContain('aria-current="true"');
    for (const label of [
      "Rescan",
      "Retry title audit",
      "Reset title limits",
      "Manually accept",
      "Ignore",
    ])
      expect(html).toContain(`>${label}</button>`);
    navigation.query = "reason=job-failure&media=movies";
    expect(
      renderToStaticMarkup(
        createElement(AttentionView, {
          queue: {
            items: filterAttention(
              items,
              attentionFilters(new URLSearchParams(navigation.query)),
            ),
            summary: { open: 3889, ignored: 12, accepted: 5 },
            mediaCounts: { all: 3000, movies: 2000, tv: 1000 },
            total: 2000,
            page: 1,
            pages: 80,
          },
        }),
      ),
    ).toContain("No items match these filters");
  });

  it("offers the shared remediation control on eligible media and attention cards while retaining Rescan", () => {
    navigation.query = "";
    const remediation = {
      mediaId: "radarr:42:/movie",
      eligible: true,
      state: "Ready" as const,
    };
    const mediaHtml = renderToStaticMarkup(
      createElement(MediaView, {
        items: [
          {
            id: remediation.mediaId,
            source: "radarr",
            arr_id: 42,
            title: "Wrong language movie",
            path: "/movie",
            decision: "fail",
            action_state: "none",
            remediation,
          },
          {
            id: "unknown",
            source: "sonarr",
            arr_id: 43,
            title: "Unknown",
            path: "/episode",
            decision: "needs-analysis",
            action_state: "none",
            remediation: { ...remediation, eligible: false },
          },
        ],
      }),
    );
    expect(mediaHtml.match(/Fix &amp; Redownload/g)).toHaveLength(1);
    expect(mediaHtml.match(/>Rescan<\/button>/g)).toHaveLength(2);
    const attentionHtml = renderToStaticMarkup(
      createElement(AttentionView, {
        queue: {
          items: [{ ...items[0], remediation }],
          summary: { open: 1, ignored: 0, accepted: 0 },
          mediaCounts: { all: 1, movies: 1, tv: 0 },
          total: 1,
          page: 1,
          pages: 1,
        },
      }),
    );
    expect(attentionHtml).toContain("Fix &amp; Redownload");
    expect(attentionHtml).toContain(">Rescan</button>");
    expect(attentionHtml).toContain(">Ignore</button>");
  });

  it("opens the existing media table with the dashboard Verified filter", () => {
    navigation.query = "status=pass";
    const rows = ["pass", "fail"].map((decision) => ({
      id: decision,
      source: "radarr",
      arr_id: 1,
      title: `${decision} title`,
      path: `/${decision}`,
      decision,
      action_state: "none",
    }));
    const html = renderToStaticMarkup(
      createElement(MediaView, { items: rows }),
    );
    expect(html).toContain("pass title");
    expect(html).not.toContain("fail title");
    expect(html).toContain('value="pass" selected=""');
  });
});
