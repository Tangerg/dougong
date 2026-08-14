import { describe, expect, it, vi } from "vitest";
import { benchmarkStartup, runAllExamples } from "../src/index";

describe("examples", () => {
  it("runs the complete learning path", async () => {
    const results = await runAllExamples();

    expect(results.map((result) => result.id)).toEqual([
      "01",
      "02",
      "03",
      "04",
      "05",
      "06",
      "07",
      "08",
      "09",
    ]);
    for (const result of results) {
      expect(
        result.facts.length,
        `${result.id} should explain its observable outcome`,
      ).toBeGreaterThan(1);
    }
  });

  it("executes both startup topologies without using wall-clock performance gates", async () => {
    const result = await benchmarkStartup(3, 1);

    expect(result).toMatchObject({ plugins: 3, delayMilliseconds: 1 });
    expect(Number.isFinite(result.independentMilliseconds)).toBe(true);
    expect(Number.isFinite(result.chainedMilliseconds)).toBe(true);
    expect(result.independentMilliseconds).toBeGreaterThanOrEqual(0);
    expect(result.chainedMilliseconds).toBeGreaterThanOrEqual(3);
  });

  it("rejects invalid benchmark inputs before constructing an application", async () => {
    await expect(benchmarkStartup(0, 1)).rejects.toThrow(TypeError);
    await expect(benchmarkStartup(1, Number.NaN)).rejects.toThrow(TypeError);
  });

  it("keeps the example and benchmark command entries executable", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await import("../src/run");
    expect(log.mock.calls.some(([message]) => String(message).includes("09  Explicit"))).toBe(true);

    log.mockClear();
    await import("../src/benchmark");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("independent topology:"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("dependency chain:"));
  });
});
