export const concepts = [
  "service",
  "provides",
  "requires",
  "host.use",

  "extension-point",
  "contribute",
  "contribution-view",
  "event",
  "contribution-dispose",

  "defer",
  "child-lifetime",
  "spawn",
  "abort-signal",

  "signal",
  "computed",
  "batch",
  "observe",

  "config-schema",
  "config-validation",
  "plugin-description",
  "change-set",
  "setup-failure",
  "rollback",

  "contract-family",
  "group",
  "atomic-commit",
  "group-removal",

  "diagnostics-view",
  "lifetime-snapshot",
  "terminal-detachment",
  "view-finalization",

  "manifest",
  "permissions",
  "data-preview",
  "activation",
  "derived-activation",

  "call-time-selection",
  "live-provider-swap",
  "platform-ownership",

  "domain-catalog",
  "workspace-ownership",
  "registration-update",

  "desired-state",
  "content-revision",
  "activation-plan",

  "module-graph",
  "invalidation-closure",
  "multi-registration-hmr",
] as const;

export type Concept = (typeof concepts)[number];

export type ExampleStage = "atoms" | "composition" | "applications";

export interface ExampleResult {
  readonly id: string;
  readonly stage: ExampleStage;
  readonly title: string;
  readonly introduces: ReadonlyArray<Concept>;
  readonly facts: ReadonlyArray<string>;
}

export type Example = () => Promise<ExampleResult>;

export function exampleResult(value: ExampleResult): ExampleResult {
  return Object.freeze({
    ...value,
    introduces: Object.freeze([...value.introduces]),
    facts: Object.freeze([...value.facts]),
  });
}

export function nextTurn() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export function whenAborted(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export function failureMessage(error: unknown): string {
  if (error instanceof AggregateError) return error.errors.map(failureMessage).join("; ");
  return error instanceof Error ? error.message : String(error);
}
