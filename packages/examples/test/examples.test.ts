import { describe, expect, it } from "vitest";
import { runAllExamples } from "../src/index";

describe("examples", () => {
  it("runs the complete learning path", async () => {
    const results = await runAllExamples();

    expect(results.map((result) => result.id)).toEqual(["01", "02", "03", "04", "05", "06", "07"]);
    for (const result of results) {
      expect(
        result.facts.length,
        `${result.id} should explain its observable outcome`,
      ).toBeGreaterThan(1);
    }
  });
});
