import { describe, it, expect } from "vitest";
import { normalizeLanguage, isCommentary } from "../src/lib/language";
describe("normalization", () => {
  it("normalizes common aliases", () => {
    expect(normalizeLanguage("English")).toBe("eng");
    expect(normalizeLanguage("en")).toBe("eng");
    expect(normalizeLanguage()).toBe("und");
  });
  it("recognizes commentary labels", () =>
    expect(isCommentary("Director's Commentary")).toBe(true));
});
