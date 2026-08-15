import type { ExampleStage } from "./example";
import { runAllExamples } from "./suite";

const stages: Record<ExampleStage, string> = {
  atoms: "Stage 1 · Atoms — one primitive at a time",
  composition: "Stage 2 · Composition — the primitives working together",
  hosts: "Stage 3 · Real hosts — what an application actually looks like",
};

let current: ExampleStage | undefined;
for (const result of await runAllExamples()) {
  if (result.stage !== current) {
    current = result.stage;
    console.log(`\n${"=".repeat(72)}\n${stages[current]}\n${"=".repeat(72)}`);
  }
  console.log(`\n${result.id}  ${result.title}`);
  console.log(`    new: ${result.introduces.join(", ")}`);
  for (const fact of result.facts) console.log(`  - ${fact}`);
}
