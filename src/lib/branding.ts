import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { audit, getConfigDir, raw } from "./store";

export const assetKind = z.enum(["logo", "compact", "background"]);
export type AssetKind = z.infer<typeof assetKind>;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

async function directory() {
  const config = await realpath(getConfigDir());
  const folder = path.join(config, "branding");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  if ((await realpath(folder)) !== folder)
    throw new Error("Branding directory must not be a symbolic link");
  return folder;
}

export async function normalizeImage(bytes: Uint8Array, contentType: string) {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES)
    throw new Error("Images must be between 1 byte and 2 MiB");
  const types: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpeg",
    "image/webp": "webp",
  };
  const expected = types[contentType];
  if (!expected) throw new Error("Only PNG, JPEG, and WebP are accepted");
  try {
    const image = sharp(bytes, {
      limitInputPixels: 4096 * 4096,
      animated: false,
      failOn: "warning",
    });
    const metadata = await image.metadata();
    if (
      metadata.format !== expected ||
      !metadata.width ||
      !metadata.height ||
      metadata.width > 4096 ||
      metadata.height > 4096 ||
      (metadata.pages || 1) > 1
    )
      throw new Error("Invalid image");
    // Decode and re-encode: never serve user-supplied metadata or trailing payloads.
    return await image.rotate().png().toBuffer();
  } catch {
    throw new Error("Invalid or oversized raster image (maximum 4096 × 4096)");
  }
}

export async function saveBranding(
  kind: AssetKind,
  bytes: Uint8Array,
  contentType: string,
) {
  assetKind.parse(kind);
  const image = await normalizeImage(bytes, contentType);
  const filename = `${randomUUID()}.png`;
  const file = await open(path.join(await directory(), filename), "wx", 0o600);
  try {
    await file.writeFile(image);
    await file.sync();
  } finally {
    await file.close();
  }
  raw()
    .transaction(() => {
      raw()
        .prepare(
          "INSERT INTO branding_assets VALUES(?,?,?) ON CONFLICT(kind) DO UPDATE SET filename=excluded.filename,content_type=excluded.content_type",
        )
        .run(kind, filename, "image/png");
      audit("branding", `${kind} image updated`, "admin");
    })
    .immediate();
  // Keep prior assets for backups; the serving API only resolves active slots.
  return { kind, url: `/api/branding/${kind}?v=${filename}` };
}

export async function readBranding(kind: AssetKind) {
  assetKind.parse(kind);
  const row = raw()
    .prepare("SELECT filename FROM branding_assets WHERE kind=?")
    .get(kind) as { filename: string } | undefined;
  if (!row) return undefined;
  if (!/^[a-f0-9-]{36}\.png$/.test(row.filename))
    throw new Error("Invalid stored image");
  const file = await open(
    path.join(await directory(), row.filename),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 80 * 1024 * 1024)
      throw new Error("Invalid stored image");
    return await file.readFile();
  } finally {
    await file.close();
  }
}

export function removeBranding(kind: AssetKind) {
  assetKind.parse(kind);
  raw().prepare("DELETE FROM branding_assets WHERE kind=?").run(kind);
  audit("branding", `${kind} image reset`, "admin");
}

export function brandingAssets() {
  const rows = raw()
    .prepare("SELECT kind,filename FROM branding_assets")
    .all() as { kind: AssetKind; filename: string }[];
  return Object.fromEntries(
    rows
      .filter((row) => assetKind.safeParse(row.kind).success)
      .map((row) => [row.kind, `/api/branding/${row.kind}?v=${row.filename}`]),
  );
}
