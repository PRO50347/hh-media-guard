import { describe, it, expect } from "vitest";
import sharp from "sharp";
import {
  normalizeImage,
  readBranding,
  saveBranding,
  removeBranding,
  MAX_IMAGE_BYTES,
} from "../src/lib/branding";
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
