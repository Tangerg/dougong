import { describe, expect, it, vi } from "vitest";
import { benchmarkStartup, concepts, runAllExamples } from "../src/index";

describe("the learning path", () => {
  it("climbs one rung at a time and teaches every concept exactly once", async () => {
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
      "10",
      "11",
      "12",
    ]);
    expect(results.map((result) => result.stage)).toEqual([
      "atoms",
      "atoms",
      "atoms",
      "atoms",
      "composition",
      "composition",
      "composition",
      "composition",
      "applications",
      "applications",
      "applications",
      "applications",
    ]);

    // The syllabus IS the reading order. Concatenating what each chapter
    // declares must reproduce `concepts` exactly: no gaps, no repeats, and no
    // concept taught after the chapter that already relied on it.
    expect(results.flatMap((result) => result.introduces)).toEqual([...concepts]);

    for (const result of results) {
      expect(result.introduces.length, `${result.id} must add something new`).toBeGreaterThan(0);
      expect(result.facts.length, `${result.id} must explain what it observed`).toBeGreaterThan(1);
    }
  });

  it("keeps each chapter's protected semantics observable", async () => {
    const facts = new Map(
      (await runAllExamples()).map((result) => [result.id, result.facts.join("\n")]),
    );

    // 03 · Ownership is a tree released in reverse, and a child is independent.
    expect(facts.get("03")).toContain("cancel:session-watcher → close:session");
    expect(facts.get("03")).toContain("cancel:editor-watcher → close:window → close:index");

    // 04 · A batch coalesces writes into one resource rebuild, and nothing leaks.
    expect(facts.get("04")).toContain("produced 1 rebuild, not two");
    expect(facts.get("04")).toContain("2 opened, 2 closed");

    // 05 · Validation precedes shutdown; rollback undoes work that already ran.
    expect(facts.get("05")).toContain("capacity must be a positive integer");
    expect(facts.get("05")).toContain("capacity 128 → 128");
    expect(facts.get("05")).toContain("started 1 time and was released 1 time");
    expect(facts.get("05")).toContain("AUDIT published = false");

    // 06 · Removing a Group removes its subtree and nothing else.
    expect(facts.get("06")).toContain("ALPHA_STORE available = false");
    expect(facts.get("06")).toContain("/beta kept serving version 2");

    // 07 · A settled task detaches; a retained view finalizes instead of retaining.
    expect(facts.get("07")).toContain("tasks 1 → 0, with the plugin still active");
    expect(facts.get("07")).toContain("finalized to phase 'disposed'");
    expect(facts.get("07")).toContain("accepts new subscribers = false");

    // 08 · The placeholder swap is one committed step, never a duplicate key.
    expect(facts.get("08")).toContain("ExtensionPoint held 1 throughout");

    // 11 · A failed plan restores the whole plan, not just the failing entry.
    expect(facts.get("11")).toContain("invalid plan was rejected = true");
    expect(facts.get("11")).toContain("running service remained 'hello-v1'");

    // 12 · Invalidation follows importers, and several Registration updates publish once.
    expect(facts.get("12")).toContain(
      "Affected Registrations were examples.hmr-module-graph.outline, examples.hmr-module-graph.search",
    );
    expect(facts.get("12")).toContain("saw 1 committed snapshot for two Registration updates");
  });
});

describe("the startup benchmark", () => {
  it("executes both topologies without using wall-clock performance gates", async () => {
    const result = await benchmarkStartup(3, 1);

    expect(result).toMatchObject({ plugins: 3, delayMilliseconds: 1 });
    expect(Number.isFinite(result.independentMilliseconds)).toBe(true);
    expect(Number.isFinite(result.chainedMilliseconds)).toBe(true);
    expect(result.independentMilliseconds).toBeGreaterThanOrEqual(0);
    expect(result.chainedMilliseconds).toBeGreaterThanOrEqual(3);
  });

  it("rejects invalid inputs before constructing an application", async () => {
    await expect(benchmarkStartup(0, 1)).rejects.toThrow(TypeError);
    await expect(benchmarkStartup(1, Number.NaN)).rejects.toThrow(TypeError);
  });
});

describe("the command entries", () => {
  it("stay executable and print the path in stages", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await import("../src/run");
    const printed = log.mock.calls.map(([message]) => String(message));
    expect(printed.some((line) => line.includes("Stage 1 · Atoms"))).toBe(true);
    expect(printed.some((line) => line.includes("Stage 3 · Applications"))).toBe(true);
    expect(printed.some((line) => line.includes("12  Module-graph invalidation"))).toBe(true);

    log.mockClear();
    await import("../src/benchmark");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("independent topology:"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("dependency chain:"));
  });
});
