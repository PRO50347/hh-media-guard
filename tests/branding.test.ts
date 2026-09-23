import { describe, it, expect } from "vitest";
import sharp from "sharp";
import {
  normalizeImage,
  readBranding,
  saveBranding,
  removeBranding,
  MAX_IMAGE_BYTES,
  assetKind,
  brandingAssets,
  type AssetKind,
} from "../src/lib/branding";
import { raw, getSettings, saveSettings } from "../src/lib/store";
import { settingsSchema } from "../src/lib/settings-schema";
import { boundedBody } from "../src/lib/http";

const raster = () =>
  sharp({
    create: { width: 16, height: 16, channels: 4, background: "#345678" },
  })
    .png()
    .toBuffer();
describe("safe persistent branding", () => {
  it("decodes, saves and reads an actual raster image, then resets the slot", async () => {
    const result = await saveBranding("logo", await raster(), "image/png");
    expect(result.url).toMatch(/^\/api\/branding\/logo\?v=[a-f0-9-]+\.png$/);
    expect((await sharp(await readBranding("logo")).metadata()).format).toBe(
      "png",
    );
    removeBranding("logo");
    expect(await readBranding("logo")).toBeUndefined();
  });
  it("rejects MIME spoofing", async () => {
    await expect(normalizeImage(await raster(), "image/jpeg")).rejects.toThrow(
      "Invalid",
    );
  });
  it("rejects scriptable SVG even disguised as PNG", async () => {
    await expect(
      normalizeImage(Buffer.from('<svg onload="alert(1)"></svg>'), "image/png"),
    ).rejects.toThrow("Invalid");
  });
  it("rejects SVG MIME", async () => {
    await expect(
      normalizeImage(Buffer.from("<svg/>"), "image/svg+xml"),
    ).rejects.toThrow("Only");
  });
  it("rejects oversized uploads before decoding", async () => {
    await expect(
      normalizeImage(new Uint8Array(MAX_IMAGE_BYTES + 1), "image/png"),
    ).rejects.toThrow("2 MiB");
  });
  it("rejects excessive dimensions", async () => {
    const bytes = await sharp({
      create: { width: 4097, height: 1, channels: 3, background: "#123456" },
    })
      .png()
      .toBuffer();
    await expect(normalizeImage(bytes, "image/png")).rejects.toThrow("4096");
  });
  it("removes trailing executable content", async () => {
    const bytes = Buffer.concat([
      await raster(),
      Buffer.from("<script>bad()</script>"),
    ]);
    expect(
      (await normalizeImage(bytes, "image/png")).includes(
        Buffer.from("<script>"),
      ),
    ).toBe(false);
  });
  it("bounds streamed requests without trusting Content-Length", async () => {
    const request = new Request("http://fixture.test", {
      method: "POST",
      body: "123456",
    });
    await expect(boundedBody(request, 5)).rejects.toThrow("size limit");
  });
});

describe("builder-managed app icons", () => {
  it("rejects retired favicon access and hides legacy uploaded favicon records", async () => {
    raw()
      .prepare(
        "INSERT INTO branding_assets VALUES('favicon','legacy.png','image/png')",
      )
      .run();
    try {
      expect(assetKind.safeParse("favicon").success).toBe(false);
      expect(brandingAssets()).not.toHaveProperty("favicon");
      await expect(readBranding("favicon" as AssetKind)).rejects.toThrow();
      await expect(
        saveBranding("favicon" as AssetKind, await raster(), "image/png"),
      ).rejects.toThrow();
      expect(() => removeBranding("favicon" as AssetKind)).toThrow();
    } finally {
      raw().prepare("DELETE FROM branding_assets WHERE kind='favicon'").run();
    }
  });
  it("ignores legacy icon URLs while preserving other saved branding", () => {
    const before = getSettings();
    raw()
      .prepare(
        "INSERT INTO settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(
        JSON.stringify({
          ...before,
          iconUrl: "https://example.test/old.png",
          appName: "Custom identity",
          accent: "#abcdef",
        }),
      );
    try {
      expect(getSettings()).not.toHaveProperty("iconUrl");
      expect(getSettings()).toMatchObject({
        appName: "Custom identity",
        accent: "#abcdef",
      });
      expect(
        settingsSchema.safeParse({
          ...getSettings(),
          iconUrl: "https://example.test/new.png",
        }).success,
      ).toBe(false);
      expect(settingsSchema.safeParse(getSettings()).success).toBe(true);
    } finally {
      saveSettings(before);
    }
  });
  for (const kind of ["logo", "compact", "background"] as const) {
    it(`keeps ${kind} uploads and resets customizable`, async () => {
      await saveBranding(kind, await raster(), "image/png");
      expect(brandingAssets()).toHaveProperty(kind);
      expect(await readBranding(kind)).toBeDefined();
      removeBranding(kind);
      expect(await readBranding(kind)).toBeUndefined();
    });
  }
});
