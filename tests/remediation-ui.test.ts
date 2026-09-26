import {
  createElement,
  isValidElement,
  type ReactNode,
  type ReactElement,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  remediationState,
  type RemediationControl,
} from "../src/lib/remediation-ui";

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (value: unknown) => [value, vi.fn()],
  useEffect: vi.fn(),
  useId: () => "remediation-description",
}));
const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  api: vi.fn<
    (
      url: string,
      options: { method: string; body: string },
    ) => Promise<{ state: string }>
  >(async () => ({ state: "Fixing" })),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }),
  usePathname: () => "/movies",
  useSearchParams: () => new URLSearchParams("status=fail&page=2&q=Movie"),
}));
vi.mock("../src/components/api", () => ({
  api: mocks.api,
  json: (method: string, body: unknown) => ({
    method,
    body: JSON.stringify(body),
  }),
}));
import { RemediationAction } from "../src/components/RemediationAction";
import { MediaView } from "../src/components/MediaView";
import { QuarantineView } from "../src/components/QuarantineView";

const ready: RemediationControl = {
  mediaId: "radarr:42:/movies/fixture.mkv",
  eligible: true,
  state: "Ready",
};
function render(control: RemediationControl) {
  return renderToStaticMarkup(createElement(RemediationAction, { control }));
}
function buttons(
  node: ReactNode,
): ReactElement<{ children?: ReactNode; onClick: () => Promise<void> }>[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (
    !isValidElement<{ children?: ReactNode; onClick: () => Promise<void> }>(
      node,
    )
  )
    return [];
  return node.type === "button" ? [node] : buttons(node.props.children);
}
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("Fix & Redownload controls", () => {
  it("requires explicit confirmation and submits only the media ID through the jobs API", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const button = buttons(RemediationAction({ control: ready }))[0];
    await button.props.onClick();
    expect(mocks.api).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await button.props.onClick();
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining(
        "quarantined and removed from the active media path",
      ),
    );
    expect(mocks.api).toHaveBeenCalledWith("/api/jobs", {
      method: "POST",
      body: JSON.stringify({ kind: "remediate", mediaId: ready.mediaId }),
    });
    expect(mocks.refresh).toHaveBeenCalled();
  });
  it("does not offer remediation without conclusive exact-file evidence", () => {
    expect(render({ ...ready, eligible: false })).not.toContain(
      "Fix &amp; Redownload",
    );
    expect(renderToStaticMarkup(createElement(RemediationAction, {}))).toBe("");
  });
  it("shows disabled controls and the server-provided explanation", () => {
    const html = render({
      ...ready,
      disabledReason:
        "Remediation is disabled: ALLOW_DESTRUCTIVE_ACTIONS must be enabled.",
    });
    expect(html).toContain('disabled=""');
    expect(html).toContain("ALLOW_DESTRUCTIVE_ACTIONS");
    expect(html).toContain('aria-describedby="remediation-description"');
  });
  it.each([
    ["queued", "Fixing"],
    ["quarantining", "Fixing"],
    ["pending", "Replacement pending"],
    ["needs-attention", "Needs attention"],
    ["failed", "Needs attention"],
    ["complete", "Complete"],
  ])("renders %s as %s", (state, label) => {
    expect(remediationState(state)).toBe(label);
    const html = render({
      ...ready,
      eligible: false,
      state: remediationState(state),
    });
    expect(html).toContain(`aria-label="Remediation state">${label}`);
    expect(html).not.toContain("Fix &amp; Redownload");
  });
  it("offers quarantine cleanup only after verified replacement and requires separate confirmation", async () => {
    const item = {
      id: "copy",
      original_path: "/movies/fixture",
      quarantine_path: "/quarantine/copy",
      state: "quarantined",
      created_at: "today",
      evidence: "{}",
    };
    expect(
      renderToStaticMarkup(createElement(QuarantineView, { items: [item] })),
    ).not.toContain("Remove failed copy");
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const cleanup = buttons(
      QuarantineView({ items: [{ ...item, cleanup_ready: 1 }] }),
    ).find((button) => button.props.children === "Remove failed copy")!;
    await cleanup.props.onClick();
    expect(mocks.api).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await cleanup.props.onClick();
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("cannot be undone"),
    );
    expect(mocks.api).toHaveBeenCalledWith("/api/quarantine", {
      method: "DELETE",
      body: '{"id":"copy"}',
    });
  });
});

describe("retry and paged media actions", () => {
  it("labels explicit safe retry and sends its operation ID after confirmation", async () => {
    const control = {
      ...ready,
      state: "Needs attention" as const,
      retryOperationId: "operation-id",
      reason: "Sonarr history response could not be parsed",
    };
    expect(render(control)).toContain("Retry Fix &amp; Redownload");
    expect(render(control)).toContain(control.reason);
    vi.stubGlobal("confirm", () => true);
    await buttons(RemediationAction({ control }))[0].props.onClick();
    expect(mocks.api).toHaveBeenCalledWith("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        kind: "remediate",
        mediaId: ready.mediaId,
        retryOperationId: "operation-id",
      }),
    });
  });
  it("rescans only the filtered current page and preserves search/status in pagination links", async () => {
    const items = Array.from({ length: 25 }, (_, i) => ({
      id: String(i + 25),
      source: "radarr",
      arr_id: i + 25,
      title: `Movie ${i + 25}`,
      path: `/movie-${i + 25}`,
      decision: "fail",
      action_state: "none",
      remediation: { ...ready, mediaId: String(i + 25) },
    }));
    const props = {
      items,
      total: 2000,
      page: 2,
      pages: 80,
      status: "fail",
      search: "Movie",
    };
    const html = renderToStaticMarkup(createElement(MediaView, props));
    expect(html).toContain("2000 matching items");
    expect(html).toContain("Page 2 of 80");
    expect(html).toContain('href="/movies?status=fail&amp;page=3&amp;q=Movie"');
    expect(html).toContain('name="q"');
    expect(html).toContain('method="get"');
    const allButtons = buttons(MediaView(props));
    await allButtons[1].props.onClick(); // Search is first; then Rescan displayed media.
    await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(25));
    expect(
      mocks.api.mock.calls.map(
        (call) => JSON.parse((call[1] as { body: string }).body).entityId,
      ),
    ).toEqual(items.map((row) => row.arr_id));
    expect(
      mocks.api.mock.calls.every(
        (call) =>
          JSON.parse((call[1] as { body: string }).body).kind ===
          "scan-library",
      ),
    ).toBe(true);
  });
});
