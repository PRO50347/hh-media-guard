import { expect, it } from "vitest";
import { jobStatusLabel } from "../src/lib/job-status";
it("distinguishes scan failures from media results including historical jobs", () => {
  expect(
    jobStatusLabel({ kind: "scan-library", state: "failed", processed: 0 }),
  ).toBe("Scan failed");
  expect(
    jobStatusLabel({
      kind: "scan-library",
      state: "needs-attention",
      processed: 0,
    }),
  ).toBe("Scan failed / setup needs attention");
  expect(
    jobStatusLabel({
      kind: "scan-library",
      state: "needs-attention",
      processed: 2,
    }),
  ).toBe("Media / operation needs attention");
  expect(
    jobStatusLabel({ kind: "scan-library", state: "completed", processed: 2 }),
  ).toBe("completed");
});
