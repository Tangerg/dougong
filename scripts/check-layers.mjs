#!/usr/bin/env node
// Layer-boundary guard for the workspace. Complements check-circular.mjs (which
// forbids cycles): this one forbids *upward* / wrong-direction import edges, and
// asserts a handful of architecture invariants that the type system cannot.
//
// Package rule (one-way, inner <- outer):
//   reactive <- core <- dougong
//
// Module rule inside @dougong/core (one-way, strictly increasing):
//   contracts/errors <- event-hub/extension-store <- lifetime <- plugin
//     <- application <- index
//
// Every invariant below is either stated in docs/architecture.zh-CN.md or was a
// deliberate narrowing that the compiler would happily let us undo.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// madge reports paths relative to `packages/`, e.g. `core/src/application.ts`.
const PACKAGES_DIR = "packages";

// —— Package layers ——————————————————————————————————————————————————

// Ordered longest-prefix-first: first match wins.
const PACKAGE_PREFIXES = [
  ["reactive/", "reactive"],
  ["core/", "core"],
  ["dougong/", "dougong"],
];

function packageOf(path) {
  for (const [prefix, name] of PACKAGE_PREFIXES) if (path.startsWith(prefix)) return name;
  return "other";
}

// Per package: the packages it must NEVER import (everything strictly outward).
const FORBIDDEN_PACKAGES = {
  reactive: ["core", "dougong"],
  core: ["dougong"],
  dougong: [],
};

// —— Core module layers ————————————————————————————————————————————————

// Every module of @dougong/core declares its rank. A module may import another
// core module only when that module's rank is strictly lower. Adding a file
// without a rank is a hard error rather than an unguarded default: the point of
// the table is that someone has to decide where a new module sits.
const CORE_MODULE_LAYERS = {
  // Foundation: pure declarations, zero imports.
  "core/src/contracts.ts": 0,
  "core/src/errors.ts": 0,
  // Leaf services over @dougong/reactive.
  "core/src/event-hub.ts": 1,
  "core/src/extension-store.ts": 1,
  // Resource ownership, built from the leaf services.
  "core/src/lifetime.ts": 2,
  // Plugin shape, declared in terms of lifetime operations.
  "core/src/plugin.ts": 3,
  // The orchestrator: the only module allowed to know all of the above.
  "core/src/application.ts": 4,
  // Public barrel.
  "core/src/index.ts": 5,
};

// —— Source-text invariants ————————————————————————————————————————————

const SOURCE_RE = /^(?:reactive|core|dougong)\/src\//;
const TEST_RE = /\.(test|spec)\.ts$/;

// Checks that run over the text of every source file under a package's `src`.
const SOURCE_RULES = [
  {
    // The kernel is host-agnostic (architecture doc: Core knows nothing about
    // HTTP, databases, windows or the filesystem). A `node:` import compiles
    // fine and then breaks only in a browser bundle.
    test: (source) => /from\s*["']node:/.test(source),
    message: "imports a Node built-in; the kernel must stay host-agnostic",
  },
  {
    // Startup order, restart closures and rollback must be reproducible. A
    // hidden clock or entropy read makes those paths untestable.
    test: (source) => /\b(?:Date\.now|performance\.now|Math\.random)\s*\(/.test(source),
    message: "reads an ambient clock or entropy source",
  },
  {
    // Diagnostics route through the `Logger` port so a host can redirect them.
    // `const defaultLogger: Logger = console` is the one sanctioned binding —
    // an assignment, not a call, so this rule does not catch it.
    test: (source) => /console\.\w+\s*\(/.test(source),
    message: "calls console directly instead of going through the Logger port",
  },
  {
    // A package entry is the only surface the published `exports` map exposes.
    // A deep path would couple consumers to our file layout.
    test: (source) =>
      /from\s*["']@dougong\/(?:reactive|core)\//.test(source) ||
      /from\s*["']\.\.\/\.\.\/(?:reactive|core|dougong)\//.test(source),
    message: "deep-imports another package instead of using its entry",
  },
];

// Checks scoped to one file, keyed by that file's madge path.
const FILE_RULES = [
  {
    file: "reactive/src/index.ts",
    // The package declares no `dependencies`. Any non-relative import would be
    // an undeclared one, and the zero-dependency claim is part of its appeal.
    test: (source) => /from\s*["'][^."']/.test(source),
    message: "@dougong/reactive must have zero external imports",
  },
  {
    file: "dougong/src/index.ts",
    // A pure facade. Logic here would be a second runtime path living outside
    // core, which is exactly what the one-canonical-API rule forbids.
    test: (source) =>
      source
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("//"))
        .some((line) => !line.startsWith("export")),
    message: "the dougong facade must contain only re-exports",
  },
  {
    file: "core/src/index.ts",
    // `Application` is deliberately an interface; `createApp()` is the only
    // constructor. Exporting the class would re-expose `LifetimeHost` and the
    // private command queue as public surface.
    test: (source) => /\bApplicationImpl\b/.test(source),
    message: "the Application implementation class must not be exported",
  },
  {
    file: "core/src/lifetime.ts",
    // `observe()` takes the structural `Readable` on purpose so external stores
    // can be observed, while `computed()` auto-tracks only branded Dougong
    // signals. Narrowing this back would silently drop external-store support.
    test: (source) => /observe<T>\(\s*source:\s*ReadonlySignal</.test(source),
    message: "observe() must accept the structural Readable, not ReadonlySignal",
  },
];

// —— Build the graph ——————————————————————————————————————————————————

let raw = "";
try {
  raw = execFileSync(
    "npx",
    [
      "madge",
      "--extensions",
      "ts",
      "--ts-config",
      "tsconfig.base.json",
      "--exclude",
      "(^|/)dist/",
      "--json",
      PACKAGES_DIR + "/",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
} catch (err) {
  // madge can exit non-zero on warnings yet still write a full graph.
  raw = err.stdout?.toString() ?? "";
}

let graph;
try {
  graph = JSON.parse(raw);
} catch {
  console.error("[check-layers] madge did not produce valid JSON:");
  console.error(raw);
  process.exit(2);
}

// —— Apply ————————————————————————————————————————————————————————————

const violations = [];
const architectureViolations = [];

for (const [file, deps] of Object.entries(graph)) {
  if (TEST_RE.test(file)) continue; // tests may reach across layers for fixtures

  const from = packageOf(file);
  const forbidden = FORBIDDEN_PACKAGES[from] ?? [];
  const fromRank = CORE_MODULE_LAYERS[file];

  if (from === "core" && file.startsWith("core/src/") && fromRank === undefined) {
    architectureViolations.push(`${file}: new core module has no rank in CORE_MODULE_LAYERS`);
  }

  for (const dep of deps) {
    const to = packageOf(dep);
    if (forbidden.includes(to)) {
      violations.push({ file, dep, from, to });
    }

    // Within core, the module order is the finer-grained rule.
    const toRank = CORE_MODULE_LAYERS[dep];
    if (fromRank !== undefined && toRank !== undefined && toRank >= fromRank) {
      violations.push({ file, dep, from: `core:${fromRank}`, to: `core:${toRank}` });
    }
  }

  if (!SOURCE_RE.test(file)) continue; // vite configs are tooling, not library source

  const source = readFileSync(join(PACKAGES_DIR, file), "utf8");
  for (const rule of SOURCE_RULES) {
    if (rule.test(source)) architectureViolations.push(`${file}: ${rule.message}`);
  }
  for (const rule of FILE_RULES) {
    if (rule.file === file && rule.test(source)) {
      architectureViolations.push(`${file}: ${rule.message}`);
    }
  }
}

// `new Lifetime(...)` is ownership creation. Only the orchestrator (one root
// lifetime per plugin instance) and Lifetime itself (child scopes) may do it;
// anywhere else produces a resource tree nobody disposes.
const LIFETIME_CONSTRUCTORS = new Set(["core/src/application.ts", "core/src/lifetime.ts"]);
for (const file of Object.keys(graph)) {
  if (!SOURCE_RE.test(file) || TEST_RE.test(file)) continue;
  if (LIFETIME_CONSTRUCTORS.has(file)) continue;
  const source = readFileSync(join(PACKAGES_DIR, file), "utf8");
  if (/\bnew\s+Lifetime\s*\(/.test(source)) {
    architectureViolations.push(`${file}: constructs a Lifetime outside the orchestrator`);
  }
}

if (violations.length > 0 || architectureViolations.length > 0) {
  console.error(`[check-layers] Found ${violations.length} layer-boundary violation(s):`);
  for (const v of violations) {
    console.error(`  ${v.from} -> ${v.to}:  ${v.file}  ->  ${v.dep}`);
  }
  for (const violation of architectureViolations) {
    console.error(`  architecture: ${violation}`);
  }
  console.error("");
  console.error("An inner layer is importing an outer one, or an architecture invariant");
  console.error("regressed. Invert the dependency, or update the tables in this script");
  console.error("with a comment explaining why the boundary moved.");
  process.exit(1);
}

console.log("[check-layers] OK — no package, module, or architecture violations.");
