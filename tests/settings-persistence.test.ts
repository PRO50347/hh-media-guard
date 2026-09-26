import { afterEach, expect, it, vi } from "vitest";
vi.mock("../src/lib/auth", () => ({ requireAdmin: vi.fn(async () => ({})) }));
import { POST } from "../src/app/api/settings/route";
import { getSettings, saveSettings } from "../src/lib/store";
const initial = getSettings();
afterEach(() => saveSettings(initial));
it.each([
  [{ setupComplete: true }, { appName: "Saved branding" }],
  [
    { requiredLanguages: ["fra"] },
    { suiteName: "Saved suite", theme: "light" },
  ],
])(
  "merges a delayed settings request with a completed concurrent save",
  async (slowPatch, fastPatch) => {
    let started!: () => void;
    let deliver!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          started();
          return new Promise<void>((resolve) => {
            deliver = () => {
              controller.enqueue(
                new TextEncoder().encode(JSON.stringify(slowPatch)),
              );
              controller.close();
              resolve();
            };
          });
        },
      },
      { highWaterMark: 0 },
    );
    const slow = POST(
      new Request("http://fixture/api/settings", {
        method: "POST",
        body,
        duplex: "half",
      } as RequestInit),
    );
    await reading;
    try {
      const fast = await POST(
        new Request("http://fixture/api/settings", {
          method: "POST",
          body: JSON.stringify(fastPatch),
        }),
      );
      expect(fast.status).toBe(200);
    } finally {
      deliver();
    }
    expect((await slow).status).toBe(200);
    expect(getSettings()).toMatchObject({ ...fastPatch, ...slowPatch });
  },
);

it("persists Manual Fix & Redownload separately and keeps the destructive environment gate", async () => {
  const previous = process.env.ALLOW_DESTRUCTIVE_ACTIONS;
  const request = () =>
    POST(
      new Request("http://fixture/api/settings", {
        method: "POST",
        body: JSON.stringify({ safetyMode: "manual" }),
      }),
    );
  try {
    process.env.ALLOW_DESTRUCTIVE_ACTIONS = "false";
    expect((await request()).status).toBe(400);
    expect(getSettings().safetyMode).toBe("monitor");
    process.env.ALLOW_DESTRUCTIVE_ACTIONS = "true";
    expect((await request()).status).toBe(200);
    expect(getSettings().safetyMode).toBe("manual");
  } finally {
    process.env.ALLOW_DESTRUCTIVE_ACTIONS = previous;
  }
});
