/**
 * The syllabus.
 *
 * Every concept below is introduced by exactly one chapter, in this order, and
 * the test concatenates what the twelve chapters declare and compares it with
 * this array. So "the path is strictly progressive, and nothing is used before
 * it is taught" is a checked invariant rather than a claim in a table.
 */
export const concepts = [
  // 01 · A stable capability and the declaration that reaches it.
  "service",
  "provides",
  "requires",
  "app.get",

  // 02 · An open contribution set, and a fact that keeps no state.
  "extension",
  "contribute",
  "extension-view",
  "event",
  "contribution-dispose",

  // 03 · The one ownership primitive everything else hangs off.
  "cleanup",
  "child-lifetime",
  "spawn",
  "abort-signal",

  // 04 · Values change; resources are rebuilt.
  "signal",
  "computed",
  "batch",
  "observe",

  // 05 · What happens when a declaration is wrong or a setup fails.
  "config-schema",
  "config-validation",
  "change-set",
  "setup-failure",
  "rollback",

  // 06 · Many instances of one shape, and who owns which subtree.
  "contract-family",
  "group",
  "atomic-commit",
  "group-removal",

  // 07 · Reading the running system without being able to steer it.
  "diagnostics-view",
  "lifetime-snapshot",
  "terminal-detachment",
  "view-finalization",

  // 08 · Code that arrives from outside the build.
  "manifest",
  "permissions",
  "placeholder",
  "activation",

  // 09 · Planet: a media host.
  "runtime-selection",
  "live-provider-swap",
  "group-scoped-platform",

  // 10 · Lynx: a workbench.
  "domain-catalog",
  "workspace-ownership",
  "plugin-update",

  // 11 · A host-owned desired-state controller.
  "desired-state",
  "content-revision",
  "platform-change-set",

  // 12 · A host-owned hot-reload strategy.
  "module-graph",
  "invalidation-closure",
  "multi-plugin-hmr",
] as const;

export type Concept = (typeof concepts)[number];

/**
 * Chapters climb three rungs: one atom at a time, then the atoms combined,
 * then the shapes real hosts actually take.
 */
export type ExampleStage = "atoms" | "composition" | "hosts";

export interface ExampleResult {
  readonly id: string;
  readonly stage: ExampleStage;
  readonly title: string;
  /** Concepts this chapter is the first in the path to use. */
  readonly introduces: ReadonlyArray<Concept>;
  /** What the run actually observed, not what the design intends. */
  readonly facts: ReadonlyArray<string>;
}

export type Example = () => Promise<ExampleResult>;

/** Freezes one chapter's outcome so the printed facts cannot be edited later. */
export function exampleResult(value: ExampleResult): ExampleResult {
  return Object.freeze({
    ...value,
    introduces: Object.freeze([...value.introduces]),
    facts: Object.freeze([...value.facts]),
  });
}

/** Lets already-scheduled reactive work and cleanups drain. */
export function nextTurn() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Resolves once the owning Lifetime cancels the task; no polling, no flags. */
export function whenAborted(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** Unwraps the AggregateError that Core uses to report several failures at once. */
export function failureMessage(error: unknown): string {
  if (error instanceof AggregateError) return error.errors.map(failureMessage).join("; ");
  return error instanceof Error ? error.message : String(error);
}
