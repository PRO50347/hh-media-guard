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
