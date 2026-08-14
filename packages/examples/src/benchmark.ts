import { benchmarkStartup } from "./startup-benchmark";

const result = await benchmarkStartup();
console.log(`${result.plugins} plugins × ${result.delayMilliseconds} ms setup`);
console.log(`  independent topology: ${result.independentMilliseconds.toFixed(1)} ms`);
console.log(`  dependency chain:     ${result.chainedMilliseconds.toFixed(1)} ms`);
