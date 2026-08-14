import { serviceBasics } from "./01-service-basics";
import { extensionAndEvent } from "./02-extension-event";
import { reactiveLifetime } from "./03-reactive-lifetime";
import { transactionsAndGroups } from "./04-transactions-groups";
import { lazyPlatform } from "./05-lazy-platform";
import { planetScenario } from "./06-planet";
import { lynxScenario } from "./07-lynx";
import type { Example, ExampleResult } from "./example";

const examples: ReadonlyArray<Example> = [
  serviceBasics,
  extensionAndEvent,
  reactiveLifetime,
  transactionsAndGroups,
  lazyPlatform,
  planetScenario,
  lynxScenario,
];

export async function runAllExamples(): Promise<ReadonlyArray<ExampleResult>> {
  const results: ExampleResult[] = [];
  for (const example of examples) results.push(await example());
  return Object.freeze(results);
}
