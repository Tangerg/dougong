import { setTimeout as scheduleTimeout } from "node:timers";
import { DougongError } from "dougong";
import { describe, expect, it, vi } from "vitest";
import { expectFailure } from "../src/example";
import { benchmarkStartup, concepts, runAllExamples } from "../src/index";

describe("the learning path", () => {
  it("propagates unexpected failures and rejects accidental success in failure demonstrations", async () => {
    const unrelated = new DougongError("HOST_QUARANTINED", "cleanup failed");
    await expect(expectFailure("TRANSITION_FAILED", () => Promise.reject(unrelated))).rejects.toBe(
      unrelated,
    );
    await expect(expectFailure("MODULE_LOAD_FAILED", () => undefined)).rejects.toThrow(
      "Expected the example operation to fail with MODULE_LOAD_FAILED",
    );
  });

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

    expect(results.flatMap((result) => result.introduces)).toEqual([...concepts]);
    expect(new Set(concepts).size).toBe(concepts.length);

    for (const result of results) {
      expect(result.introduces.length, `${result.id} must add something new`).toBeGreaterThan(0);
      expect(result.facts.length, `${result.id} must explain what it observed`).toBeGreaterThan(1);
    }
  });

  it("keeps each chapter's protected semantics observable", async () => {
    const facts = new Map(
      (await runAllExamples()).map((result) => [result.id, result.facts.join("\n")]),
    );

    expect(facts.get("03")).toContain("cancel:session-watcher → close:session");
    expect(facts.get("03")).toContain("cancel:editor-watcher → close:window → close:index");

    expect(facts.get("04")).toContain("produced 1 rebuild, not two");
    expect(facts.get("04")).toContain("2 opened, 2 closed");

    expect(facts.get("05")).toContain("configuration schema 'unavailable', with 0 setup calls");
    expect(facts.get("05")).toContain("capacity must be a positive integer");
    expect(facts.get("05")).toContain("capacity 128 → 128");
    expect(facts.get("05")).toContain("started 1 time and was released 1 time");
    expect(facts.get("05")).toContain("AUDIT published = false");

    expect(facts.get("06")).toContain("ALPHA_STORE available = false");
    expect(facts.get("06")).toContain("/beta kept serving version 2");

    expect(facts.get("07")).toContain("tasks 1 → 0, with the plugin still active");
    expect(facts.get("07")).toContain("declarations and no live Lifetime references");

    expect(facts.get("08")).toContain(
      "ExtensionPoint held 0 executable commands; loading published 1",
    );

    expect(facts.get("08")).toContain(
      "One action declaration supplied discovery metadata, contribution identity and derived activation events",
    );

    expect(facts.get("09")).toContain(
      "Replacing playback aborted 1 late playback completion before it could publish a track",
    );

    expect(facts.get("09")).not.toContain("remote:superseded");

    expect(facts.get("10")).toContain("panel now 'Files'");
    expect(facts.get("10")).toContain("its panel view reports LIFETIME_DISPOSED");
    expect(facts.get("11")).toContain("The missing module caused MODULE_LOAD_FAILED");
    expect(facts.get("11")).toContain("running service remained 'hello-v1'");

    expect(facts.get("12")).toContain(
      "Affected Registrations were examples.hot-module-replacement.outline, examples.hot-module-replacement.search",
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
    expect(result.chainedMilliseconds).toBeGreaterThanOrEqual(0);
  });

  it("rejects invalid inputs before constructing an application", async () => {
    await expect(benchmarkStartup(0, 1)).rejects.toThrow(TypeError);
  });

  it.each([0, -1, 0.5, 1.5, Number.NaN, Infinity, -Infinity, 2_147_483_648])(
    "rejects a delay the timer cannot represent without coercion: %s",
    async (delayMilliseconds) => {
      const schedule = vi.spyOn(globalThis, "setTimeout");
      await expect(benchmarkStartup(1, delayMilliseconds)).rejects.toThrow(TypeError);
      expect(schedule).not.toHaveBeenCalled();
    },
  );

  it("passes the maximum accepted delay unchanged to both topology timers", async () => {
    const maximumDelayMilliseconds = 2_147_483_647;
    const schedule = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback, delay, ...callbackArguments) =>
        scheduleTimeout(
          callback,
          delay === maximumDelayMilliseconds ? 1 : delay,
          ...callbackArguments,
        ),
      );
    try {
      const result = await benchmarkStartup(1, maximumDelayMilliseconds);

      expect(result.delayMilliseconds).toBe(maximumDelayMilliseconds);
      expect(
        schedule.mock.calls.filter(([, delay]) => delay === result.delayMilliseconds),
      ).toHaveLength(2);
    } finally {
      schedule.mockRestore();
    }
  });
});

describe("the command entries", () => {
  it("stay executable and print the path in stages", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await import("../src/run");
    const printed = consoleLog.mock.calls.map(([message]) => String(message));
    expect(printed.some((line) => line.includes("Stage 1 · Atoms"))).toBe(true);
    expect(printed.some((line) => line.includes("Stage 3 · Applications"))).toBe(true);
    expect(printed.some((line) => line.includes("12  Module-graph invalidation"))).toBe(true);

    consoleLog.mockClear();
    await import("../src/benchmark");
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining("independent topology:"));
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining("dependency chain:"));
  });
});
