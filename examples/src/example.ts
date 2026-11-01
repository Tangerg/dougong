import { DougongError } from "dougong";
import { onAbort } from "dougong/advanced";
const curriculum = [
  { id: "01", stage: "atoms", introduces: ["service", "provides", "requires", "host.use"] },
  {
    id: "02",
    stage: "atoms",
    introduces: [
      "extension-point",
      "contribute",
      "contribution-view",
      "event",
      "contribution-dispose",
    ],
  },
  { id: "03", stage: "atoms", introduces: ["defer", "child-lifetime", "spawn", "abort-signal"] },
  { id: "04", stage: "atoms", introduces: ["signal", "computed", "batch", "observe"] },
  {
    id: "05",
    stage: "composition",
    introduces: [
      "configuration-schema",
      "configuration-validation",
      "plugin-description",
      "change-set",
      "setup-failure",
      "rollback",
    ],
  },
  {
    id: "06",
    stage: "composition",
    introduces: ["contract-family", "group", "atomic-commit", "group-removal"],
  },
  {
    id: "07",
    stage: "composition",
    introduces: [
      "diagnostics-view",
      "lifetime-snapshot",
      "terminal-detachment",
      "view-finalization",
    ],
  },
  {
    id: "08",
    stage: "composition",
    introduces: ["manifest", "permissions", "data-preview", "activation", "derived-activation"],
  },
  {
    id: "09",
    stage: "applications",
    introduces: ["call-time-selection", "live-provider-swap", "platform-ownership"],
  },
  {
    id: "10",
    stage: "applications",
    introduces: ["domain-catalog", "workspace-ownership", "registration-update"],
  },
  {
    id: "11",
    stage: "applications",
    introduces: ["desired-state", "content-revision", "activation-plan"],
  },
  {
    id: "12",
    stage: "applications",
    introduces: [
      "module-graph",
      "invalidation-closure",
      "multi-registration-hot-module-replacement",
    ],
  },
] as const;

type Chapter = (typeof curriculum)[number];
export type Concept = Chapter["introduces"][number];
export type ExampleStage = Chapter["stage"];
export const concepts: ReadonlyArray<Concept> = Object.freeze(
  curriculum.flatMap<Concept>((chapter) => chapter.introduces),
);

export interface ExampleResult {
  readonly id: Chapter["id"];
  readonly stage: ExampleStage;
  readonly title: string;
  readonly introduces: ReadonlyArray<Concept>;
  readonly facts: ReadonlyArray<string>;
}

export type Example = () => Promise<ExampleResult>;

export function exampleResult(value: Pick<ExampleResult, "id" | "title" | "facts">): ExampleResult {
  const chapter = curriculum.find(({ id }) => id === value.id);
  if (!chapter) throw new TypeError(`Unknown example chapter '${value.id}'`);
  return Object.freeze({
    ...value,
    stage: chapter.stage,
    introduces: Object.freeze([...chapter.introduces]),
    facts: Object.freeze([...value.facts]),
  });
}

export function nextTurn() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export function whenAborted(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    onAbort(signal, () => resolve());
  });
}

export async function expectFailure(code: string, operation: () => unknown): Promise<DougongError> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof DougongError && error.code === code) return error;
    throw error;
  }
  throw new Error(`Expected the example operation to fail with ${code}`);
}
