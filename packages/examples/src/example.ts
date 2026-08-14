export interface ExampleResult {
  readonly id: string;
  readonly title: string;
  readonly facts: ReadonlyArray<string>;
}

export type Example = () => Promise<ExampleResult>;

export function nextTurn() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}
