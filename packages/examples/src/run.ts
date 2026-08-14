import { runAllExamples } from "./suite";

for (const result of await runAllExamples()) {
  console.log(`\n${result.id}  ${result.title}`);
  for (const fact of result.facts) console.log(`  - ${fact}`);
}
