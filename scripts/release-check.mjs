import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
assert.equal(lock.version, pkg.version, "Lockfile version mismatch");
assert.equal(
  lock.packages[""].version,
  pkg.version,
  "Root lock package version mismatch",
);
assert.equal(
  readFileSync("Dockerfile", "utf8").match(/^ARG APP_VERSION=(.+)$/m)?.[1],
  pkg.version,
  "Docker default version mismatch",
);
if (process.env.GITHUB_REF_TYPE === "tag")
  assert.equal(
    process.env.GITHUB_REF_NAME,
    `v${pkg.version}`,
    "Release tag version mismatch",
  );
assert.match(
  readFileSync("CHANGELOG.md", "utf8"),
  new RegExp(`^## ${pkg.version.replaceAll(".", "\\.")}$`, "m"),
  "Changelog version missing",
);
console.log(`Package, lockfile, Docker and changelog agree at ${pkg.version}`);
