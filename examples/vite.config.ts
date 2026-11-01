import { libraryBuild } from "../tooling/library-build.mjs";
import manifest from "./package.json" with { type: "json" };

export default libraryBuild(manifest, { run: "src/run.ts", benchmark: "src/benchmark.ts" });
