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
  api: vi.fn(async () => ({ state: "Fixing" })),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));
vi.mock("../src/components/api", () => ({
  api: mocks.api,
  json: (method: string, body: unknown) => ({
    method,
    body: JSON.stringify(body),
  }),
}));
import { RemediationAction } from "../src/components/RemediationAction";
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
