import { realpath, stat } from "node:fs/promises";
import path from "node:path";
export { serviceUrl as safeRemoteUrl } from "./arr-transport";

export function within(root: string, target: string) {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}
export function validAbsolute(input: string) {
  if (
    !path.isAbsolute(input) ||
    input.includes("\0") ||
    input.split(/[\\/]/).includes("..")
  )
    throw new Error("Use an absolute path without traversal segments");
  return path.resolve(input);
}
export function approvedRoots() {
  return (process.env.MEDIA_ROOTS || "/movies,/tv")
    .split(",")
    .filter(Boolean)
    .map(validAbsolute);
}
export async function validateMappingRoot(
  input: string,
  approved = approvedRoots(),
) {
  const lexical = validAbsolute(input);
  if (!approved.some((root) => root !== "/" && within(root, lexical)))
    throw new Error("Mapping is outside MEDIA_ROOTS");
  const resolved = await realpath(lexical);
  let permitted = false;
  for (const root of approved.filter((root) => within(root, lexical))) {
    const canonical = await realpath(root);
    if (within(canonical, resolved)) permitted = true;
  }
  if (!permitted)
    throw new Error("Mapping symlink escapes the approved media root");
  if (!(await stat(resolved)).isDirectory())
    throw new Error("Mapping target must be a directory");
  return resolved;
}
export async function safeMediaPath(input: string, roots: string[]) {
  const lexical = validAbsolute(input);
  const candidates = roots.filter(
    (root) => root !== "/" && within(path.resolve(root), lexical),
  );
  if (!candidates.length)
    throw new Error("File is outside configured media mappings");
  const resolved = await realpath(lexical);
  let permitted = false;
  for (const root of candidates) {
    const canonical = await realpath(root);
    if (canonical !== path.resolve(root))
      throw new Error(
        "Mapped root changed to a symlink; revalidate the mapping",
      );
    if (within(canonical, resolved)) permitted = true;
  }
  if (!permitted) throw new Error("File symlink escapes the mapped media root");
  if (!(await stat(resolved)).isFile())
    throw new Error("Media must be a regular file");
  return resolved;
}
