#!/usr/bin/env node
// Layer-boundary guard for the workspace. Complements check-circular.mjs (which
// forbids cycles): this one forbids *upward* / wrong-direction import edges, and
// asserts a handful of architecture invariants that the type system cannot.
//
// Package rule: Core and reactive are independent foundations; Platform only
// depends on Core, the facade may re-export all three, and examples is the
// outermost consumer that no runtime package may import.
//
// Module rules inside @dougongjs/core and @dougongjs/platform are one-way and
// strictly increasing. Their tables below are exhaustive by design.
//
// Every invariant below is either stated in docs/architecture.zh-CN.md or was a
// deliberate narrowing that the compiler would happily let us undo.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// madge reports paths relative to `packages/`, e.g. `core/src/application.ts`.
const PACKAGES_DIR = "packages";

// Package layers

// Ordered longest-prefix-first: first match wins.
const PACKAGE_PREFIXES = [
  ["examples/", "examples"],
  ["reactive/", "reactive"],
  ["core/", "core"],
  ["platform/", "platform"],
  ["dougong/", "dougong"],
];

function packageOf(path) {
  for (const [prefix, name] of PACKAGE_PREFIXES) if (path.startsWith(prefix)) return name;
  return "other";
}

// Per package: the packages it must NEVER import (everything strictly outward).
const FORBIDDEN_PACKAGES = {
  reactive: ["core", "platform", "dougong", "examples"],
  core: ["reactive", "platform", "dougong", "examples"],
  platform: ["dougong", "examples"],
  dougong: ["examples"],
  examples: [],
};

// Core module layers

// Every module of @dougongjs/core declares its rank. A module may import another
// core module only when that module's rank is strictly lower. Adding a file
// without a rank is a hard error rather than an unguarded default: the point of
// the table is that someone has to decide where a new module sits.
const CORE_MODULE_LAYERS = {
  // Foundation: pure declarations and structural values.
  "core/src/contracts.ts": 0,
  "core/src/errors.ts": 0,
  "core/src/group.ts": 0,
  "core/src/readonly-map.ts": 0,
  "core/src/resource.ts": 0,
  "core/src/serial-queue.ts": 0,
  // Leaf state and fan-out services over standard JavaScript only.
  "core/src/contract-registry.ts": 1,
  "core/src/event-hub.ts": 1,
  "core/src/snapshot-view.ts": 1,
  // Live extension stores and Lifetime diagnostics share the snapshot protocol.
  "core/src/extension-store.ts": 2,
  "core/src/lifetime-diagnostics.ts": 2,
  // Resource ownership, built from the leaf services and its diagnostic projection.
  "core/src/lifetime.ts": 3,
  // Plugin shape, declared in terms of lifetime operations.
  "core/src/plugin.ts": 4,
  // Stable installation identity and its runtime state machine.
  "core/src/installation.ts": 5,
  // Derived graphs and immutable operational read models.
  "core/src/diagnostics.ts": 6,
  "core/src/group-lifecycle.ts": 6,
  "core/src/plugin-graph.ts": 6,
  // Public protocols, then the canonical ChangeSet implementation.
  "core/src/host-api.ts": 7,
  "core/src/change-set.ts": 8,
  // Structural Group orchestration and the committed runtime are orthogonal.
  "core/src/runtime.ts": 9,
  "core/src/group-coordinator.ts": 9,
  // The Host serializes public commands over both collaborators.
  "core/src/host.ts": 10,
  // Public barrel.
  "core/src/index.ts": 11,
};

const PLATFORM_MODULE_LAYERS = {
  "platform/src/errors.ts": 0,
  "platform/src/loader.ts": 0,
  "platform/src/manifest.ts": 1,
  "platform/src/diagnostics.ts": 2,
  "platform/src/permissions.ts": 2,
  "platform/src/platform-api.ts": 3,
  // Artifact declarations compile into validated Core plugin definitions.
  "platform/src/artifact.ts": 4,
  "platform/src/registration.ts": 4,
  "platform/src/platform-change-set.ts": 5,
  // Candidate and Core graphs are independent projections of one sealed change.
  "platform/src/candidate-graph.ts": 6,
  "platform/src/core-change.ts": 6,
  "platform/src/platform.ts": 7,
  "platform/src/index.ts": 8,
};

const MODULE_LAYERS = { ...CORE_MODULE_LAYERS, ...PLATFORM_MODULE_LAYERS };

// Source-text invariants

const SOURCE_RE = /^(?:reactive|core|platform|dougong)\/src\//;
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
    // `const defaultLogger: Logger = console` is the one sanctioned binding.
    // an assignment, not a call, so this rule does not catch it.
    test: (source) => /console\.\w+\s*\(/.test(source),
    message: "calls console directly instead of going through the Logger port",
  },
  {
    // A package entry is the only surface the published `exports` map exposes.
    // A deep path would couple consumers to our file layout.
    test: (source) =>
      /from\s*["']@dougong\/(?:reactive|core|platform)\//.test(source) ||
      /from\s*["']\.\.\/\.\.\/(?:reactive|core|platform|dougong)\//.test(source),
    message: "deep-imports another package instead of using its entry",
  },
];

// Checks scoped to one file, keyed by that file's madge path.
const FILE_RULES = [
  {
    matches: (file) => file.startsWith("reactive/src/"),
    // The package declares no `dependencies`. Any non-relative import would be
    // an undeclared one, and the zero-dependency claim is part of its appeal.
    test: (source) => /from\s*["'][^."']/.test(source),
    message: "@dougongjs/reactive must have zero external imports",
  },
  {
    matches: (file) => file === "dougong/src/index.ts",
    // A pure facade. Logic here would be a second runtime path living outside
    // core, which is exactly what the one-canonical-API rule forbids.
    test: (source) =>
      source
        .replace(/\/\/[^\n]*/g, "")
        .replace(/export\s+(?:type\s+)?(?:\*|{[\s\S]*?})\s+from\s+["'][^"']+["'];?/g, "")
        .trim().length > 0,
    message: "the dougong facade must contain only re-exports",
  },
  {
    matches: (file) => file === "core/src/index.ts",
    // `Host` is deliberately an interface; `createHost()` is the only
    // constructor. Exporting the class would re-expose `LifetimePort` and the
    // private command queue as public surface.
    test: (source) => /\bHostImpl\b/.test(source),
    message: "the Host implementation class must not be exported",
  },
  {
    matches: (file) => file === "core/src/host.ts",
    test: (source) =>
      !/new\s+SerialQueue\s*\(/.test(source) ||
      /\.then\(\s*operation\s*,\s*operation\s*\)/.test(source),
    message: "Host command serialization must use Core SerialQueue",
  },
  {
    matches: (file) =>
      file === "platform/src/platform.ts" || file === "platform/src/registration.ts",
    test: (source) => !/new\s+SerialQueue\s*\(/.test(source),
    message: "Platform command serialization must use Core SerialQueue",
  },
  {
    matches: (file) => file === "platform/src/diagnostics.ts",
    test: (source) => !/new\s+SnapshotPublisher\s*\(/.test(source),
    message: "Platform diagnostics must compile to Core SnapshotPublisher",
  },
];

// Build the graph

let raw = "";
try {
  raw = execFileSync(
    "pnpm",
    [
      "exec",
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

// Apply the rules

const violations = [];
const architectureViolations = [];

for (const [file, deps] of Object.entries(graph)) {
  if (TEST_RE.test(file)) continue; // tests may reach across layers for fixtures

  const from = packageOf(file);
  const forbidden = FORBIDDEN_PACKAGES[from] ?? [];
  const fromRank = MODULE_LAYERS[file];

  if (from === "core" && file.startsWith("core/src/") && fromRank === undefined) {
    architectureViolations.push(`${file}: new core module has no rank in CORE_MODULE_LAYERS`);
  }
  if (from === "platform" && file.startsWith("platform/src/") && fromRank === undefined) {
    architectureViolations.push(
      `${file}: new platform module has no rank in PLATFORM_MODULE_LAYERS`,
    );
  }

  for (const dep of deps) {
    const to = packageOf(dep);
    if (forbidden.includes(to)) {
      violations.push({ file, dep, from, to });
    }

    // Within core, the module order is the finer-grained rule.
    const toRank = MODULE_LAYERS[dep];
    if (from === to && fromRank !== undefined && toRank !== undefined && toRank >= fromRank) {
      violations.push({ file, dep, from: `${from}:${fromRank}`, to: `${to}:${toRank}` });
    }
  }

  if (!SOURCE_RE.test(file)) continue; // vite configs are tooling, not library source

  const source = readFileSync(join(PACKAGES_DIR, file), "utf8");
  for (const rule of SOURCE_RULES) {
    if (rule.test(source)) architectureViolations.push(`${file}: ${rule.message}`);
  }
  for (const rule of FILE_RULES) {
    if (rule.matches(file) && rule.test(source)) {
      architectureViolations.push(`${file}: ${rule.message}`);
    }
  }
}

// `new Lifetime(...)` is ownership creation. Only the orchestrator (one root
// lifetime per plugin installation) and Lifetime itself (children) may do it;
// anywhere else produces a resource tree nobody disposes.
const LIFETIME_CONSTRUCTORS = new Set(["core/src/runtime.ts", "core/src/lifetime.ts"]);
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

console.log("[check-layers] OK: no package, module, or architecture violations.");
