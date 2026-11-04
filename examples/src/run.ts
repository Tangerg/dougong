import type { ExampleStage } from "./example.js";
import { runAllExamples } from "./suite.js";

const stages: Record<ExampleStage, string> = {
  atoms: "Stage 1 · Atoms — one primitive at a time",
  composition: "Stage 2 · Composition — the primitives working together",
  applications: "Stage 3 · Applications — what a complete product actually looks like",
};
const headingWidth = 72;
const headingSeparator = "=".repeat(headingWidth);

let current: ExampleStage | undefined;
for (const result of await runAllExamples()) {
  if (result.stage !== current) {
    current = result.stage;
    console.log(`\n${headingSeparator}\n${stages[current]}\n${headingSeparator}`);
  }
  console.log(`\n${result.id}  ${result.title}`);
  console.log(`    new: ${result.introduces.join(", ")}`);
  for (const fact of result.facts) console.log(`  - ${fact}`);
}
