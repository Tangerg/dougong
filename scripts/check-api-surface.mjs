#!/usr/bin/env node
// Public declaration guard. Complements check-layers.mjs (import direction) and
// the value-level `api-surface.test.ts` (which cannot see type-only exports):
// this one reads the *built* `dist/index.d.ts` of every published package and asserts the exact
// exported vocabulary, values and types alike.
//
// Three independent assertions per package:
//
//   1. The exported identifiers equal the allowlist exactly. A new export is a
//      deliberate decision, not a side effect of an `export *`.
//   2. No retired identifier reappears in a package entry declaration. The
//      banlist holds whole tokens, never patterns, so `Plugin`, `PluginContext`,
//      `InstanceMeta`, `definePlugin` and other valid Plugin-related names
//      stay legal while `PluginHandle` and friends cannot come back.
//   3. Every public export appears in the Chinese and English documentation for
//      its package. Updating the allowlist cannot leave a supported API unexplained.
//
// Symbols are resolved through the TypeScript checker rather than matched as
// text, so `export *` re-exports are seen as the final surface a consumer gets.
//
// Run after `pnpm build`; `dist/index.d.ts` is the only place the full type
// surface exists as an artifact.

import { createRequire } from "node:module";
import { existsSync, globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { retiredVocabulary } from "./vocabulary.mjs";

const ts = createRequire(import.meta.url)("typescript");
const retiredIdentifiers = new Set(retiredVocabulary);

// The vocabulary. One name per lifecycle stage:
//
//   Manifest + Reference -> Artifact -> Registration   (Platform: external code)
//   Plugin -> Installation                             (Core: stable public identity)
//             \-> Instance                             (internal active execution)
//
// Host is the execution boundary Dougong owns. The code that embeds Dougong is
// "application code"; the JavaScript environment is the "runtime". Neither is
// called a host on this surface.
const PACKAGES = {
  "@dougongjs/reactive": {
    dist: "packages/reactive/dist/index.d.ts",
    values: ["batch", "computed", "observe", "signal"],
    types: [
      "AsyncDisposable",
      "Disposable",
      "ObservationLifetime",
      "ObservationOwner",
      "ObservationTask",
      "Observer",
      "Readable",
      "ReadonlySignal",
      "Signal",
    ],
  },

  "@dougongjs/core": {
    dist: "packages/core/dist/index.d.ts",
    values: [
      "ConfigValidationError",
      "DougongError",
      "ReadonlyMapSnapshot",
      "SerialQueue",
      "SnapshotPublisher",
      "assertPlainRecord",
      "createHost",
      "definePlugin",
      "event",
      "extensionPoint",
      "isCancellationReason",
      "isLogger",
      "optional",
      "service",
    ],
    types: [
      // Contract identity.
      "ContractKind",
      "ContractValue",
      "Event",
      "ExtensionPoint",
      "OptionalService",
      "Requirement",
      "Service",
      // The declaration and its context.
      "Awaitable",
      "Plugin",
      "PluginContext",
      "InstanceMeta",
      "ProvidedServices",
      "Provisions",
      "Requirements",
      "ResolvedRequirement",
      "ResolvedRequirements",
      // The execution boundary and what lives inside it.
      "ChangeSet",
      "Group",
      "GroupSnapshot",
      "Host",
      "HostOptions",
      "HostSnapshot",
      "HostStatus",
      "Installation",
      "InstallationSnapshot",
      "InstallationUpdate",
      "Installer",
      "LifecycleStatus",
      // Ownership.
      "AsyncDisposable",
      "BackgroundTask",
      "Cleanup",
      "Disposable",
      "LifetimeContext",
      "LifetimeOperations",
      "LifetimePhase",
      "LifetimeSnapshot",
      "Task",
      // Open contribution sets and observation.
      "Contribution",
      "ContributionView",
      "EventListener",
      "Logger",
      "SnapshotView",
    ],
  },

  "@dougongjs/platform": {
    dist: "packages/platform/dist/index.d.ts",
    values: [
      "ImportLoader",
      "MemoryLoader",
      "PermissionDeniedError",
      "PermissionSet",
      "PlatformError",
      "createPlatform",
      "defineManifest",
    ],
    types: [
      "Artifact",
      "Authorizer",
      "Loader",
      "Manifest",
      "ManifestInput",
      "Platform",
      "PlatformChangeSet",
      "PlatformOptions",
      "PlatformSnapshot",
      "PlatformStatus",
      "Registration",
      "RegistrationSnapshot",
      "RegistrationStatus",
    ],
  },

  dougong: {
    dist: "packages/dougong/dist/index.d.ts",
    // The facade is a pure re-export layer: its surface is exactly Core plus
    // Platform plus the reactive names it forwards. Computed, not restated, so
    // the two cannot drift.
    values: null,
    types: null,
  },
};

function surfaceOf(distPath) {
  const file = resolve(distPath);
  const program = ts.createProgram([file], {
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file);
  if (!source) throw new Error(`Cannot read ${distPath}`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error(`${distPath} is not a module`);

  const values = new Set();
  const types = new Set();
  const retired = new Set();
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const symbol =
      exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    // A class is both; classify it as a value so each name lands in exactly one
    // bucket and the two allowlists stay disjoint.
    if (symbol.flags & ts.SymbolFlags.Value) values.add(exported.name);
    else if (symbol.flags & ts.SymbolFlags.Type) types.add(exported.name);
    else throw new Error(`${distPath} exports '${exported.name}' with no value or type meaning`);
  }
  const visit = (node) => {
    if (ts.isIdentifier(node) && retiredIdentifiers.has(node.text)) retired.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { values: [...values].sort(), types: [...types].sort(), retired: [...retired].sort() };
}

function difference(actual, expected) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  return {
    added: actual.filter((name) => !expectedSet.has(name)),
    missing: expected.filter((name) => !actualSet.has(name)),
  };
}

const failures = [];
const surfaces = new Map();

for (const [name, spec] of Object.entries(PACKAGES)) {
  if (!existsSync(resolve(spec.dist))) {
    failures.push(`${name}: ${spec.dist} is missing — run \`pnpm build\` first`);
    continue;
  }
  surfaces.set(name, surfaceOf(spec.dist));
}

for (const [name, spec] of Object.entries(PACKAGES)) {
  const surface = surfaces.get(name);
  if (!surface) continue;

  if (spec.values && spec.types) {
    for (const [kind, expected] of [
      ["value", spec.values],
      ["type", spec.types],
    ]) {
      const { added, missing } = difference(surface[`${kind}s`], expected);
      for (const item of added) failures.push(`${name}: undeclared ${kind} export '${item}'`);
      for (const item of missing) failures.push(`${name}: missing ${kind} export '${item}'`);
    }
  }

  for (const item of surface.retired) {
    failures.push(`${name}: retired identifier '${item}' appears in its declaration surface`);
  }
}

// The facade must be exactly Core + Platform + the forwarded reactive names, and
// nothing of its own. Checked against the parsed surfaces, not the source text.
const facade = surfaces.get("dougong");
const core = surfaces.get("@dougongjs/core");
const platform = surfaces.get("@dougongjs/platform");
const reactive = surfaces.get("@dougongjs/reactive");
if (facade && core && platform && reactive) {
  const expectedFacade = {
    values: [...new Set([...core.values, ...platform.values, ...reactive.values])].sort(),
    types: [...new Set([...core.types, ...platform.types, ...reactive.types])].sort(),
  };
  for (const kind of ["values", "types"]) {
    const { added, missing } = difference(facade[kind], expectedFacade[kind]);
    for (const item of added) {
      failures.push(
        `dougong: facade declares ${kind.slice(0, -1)} '${item}' with no upstream export`,
      );
    }
    for (const item of missing) {
      failures.push(`dougong: facade does not re-export the ${kind.slice(0, -1)} '${item}'`);
    }
  }
}

// Error codes are public API too, and the only copy of them a consumer reads is
// the reference table. Derive the real set from error construction sites and
// require both language versions to list exactly it. Looking at AST context
// avoids mistaking an unrelated uppercase string constant for an error code.
const ERROR_CODE_RE = /^[A-Z][A-Z_]{3,}$/;
const sourceCodes = new Set();
for (const dir of ["packages/core/src", "packages/platform/src"]) {
  for (const file of globSync(`${dir}/*.ts`)) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const visit = (node) => {
      if (ts.isStringLiteralLike(node) && ERROR_CODE_RE.test(node.text)) {
        const parent = node.parent;
        const isErrorConstruction =
          ts.isNewExpression(parent) &&
          parent.arguments?.[0] === node &&
          ts.isIdentifier(parent.expression) &&
          (parent.expression.text === "DougongError" || parent.expression.text === "PlatformError");
        const isErrorSubclass =
          ts.isCallExpression(parent) &&
          parent.arguments[0] === node &&
          parent.expression.kind === ts.SyntaxKind.SuperKeyword;
        const isFailureNormalization =
          ts.isCallExpression(parent) &&
          parent.arguments[1] === node &&
          ts.isIdentifier(parent.expression) &&
          parent.expression.text === "normalizeFailure";
        if (isErrorConstruction || isErrorSubclass || isFailureNormalization) {
          sourceCodes.add(node.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}
// Prose naming a code that no longer exists is worse than prose omitting one, so
// every page is checked for invented codes; only the two reference tables must
// additionally be exhaustive.
const REFERENCE_TABLES = ["docs/reference/errors.md", "docs/en/reference/errors.md"];
const MARKDOWN_FILES = [
  ...globSync("docs/**/*.md"),
  ...globSync("packages/*/README.md"),
  "README.md",
  "README.en.md",
];
const retiredDocPatterns = [...retiredIdentifiers].map((term) => [
  term,
  new RegExp(`(?<![\\w$-])${escapeRegExp(term)}(?![\\w$-])`),
]);

for (const doc of MARKDOWN_FILES) {
  if (doc.includes(".vitepress")) continue;
  const text = readFileSync(doc, "utf8");
  const code = markdownCode(text).join("\n");
  for (const [term, pattern] of retiredDocPatterns) {
    if (pattern.test(code)) failures.push(`${doc}: uses retired code term '${term}'`);
  }
  const documented = new Set(
    [...text.matchAll(/`([A-Z][A-Z_]{3,})`/g)]
      .map(([, code]) => code)
      .filter((code) => !code.endsWith("_")),
  );
  for (const code of documented) {
    if (!sourceCodes.has(code))
      failures.push(`${doc}: documents '${code}', which no source throws`);
  }
  if (!REFERENCE_TABLES.includes(doc)) continue;
  for (const code of sourceCodes) {
    if (!documented.has(code)) failures.push(`${doc}: error code '${code}' is not documented`);
  }
}

// The guard reference page claims to list every architecture rule. Rule prose is
// translated, so matching messages by keyword would produce false failures in
// one language and false passes in the other. Counting rows is language
// independent: it does not prove a given row describes a given rule, but adding
// a rule and forgetting to document it cannot pass, which is the regression that
// produced a stale gate section before this page existed.
const GUARD_PAGES = ["docs/reference/guards.md", "docs/en/reference/guards.md"];
const gateSource = readFileSync("scripts/check-layers.mjs", "utf8");
const sourceRuleCount = [...gateSource.matchAll(/message:\s*\n?\s*"[^"]+"/g)].length;
// Prohibitions enforced outside SOURCE_RULES, currently the Lifetime constructor
// allowlist. Counted from its own marker so the total stays derived.
const standaloneRuleCount = [...gateSource.matchAll(/^const [A-Z_]+_CONSTRUCTORS\b/gm)].length;
const expectedRuleRows = sourceRuleCount + standaloneRuleCount;
for (const page of GUARD_PAGES) {
  const documentedRules = [...readFileSync(page, "utf8").matchAll(/^\|.+\|$/gm)]
    .map(([row]) => row)
    .filter((row) => !/^\|[\s-:|]+\|$/.test(row)) // separator rows
    // The step table is keyed by a number and the coverage table by a package
    // name; every remaining data row is one architecture rule.
    .filter((row) => !/^\|\s*(?:#|\d+|core|platform|reactive|包|Package)\s*\|/.test(row))
    .filter((row) => !/^\|\s*(?:规则|Rule)\s*\|/.test(row)).length; // rule table headers
  if (documentedRules !== expectedRuleRows) {
    failures.push(
      `${page}: documents ${documentedRules} architecture rules, but check-layers.mjs enforces ${expectedRuleRows}`,
    );
  }
}

function markdownCode(text) {
  const fragments = [];
  const prose = text.replace(
    /(?:^|\n)(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n\1(?=\n|$)/g,
    (_block, _fence, info, code) => {
      if (/^\s*(?:[cm]?[jt]sx?|typescript|javascript|json)\b/i.test(info)) {
        fragments.push(code);
      }
      return "\n";
    },
  );
  for (const match of prose.matchAll(/`([^`\n]+)`/g)) fragments.push(match[1]);
  return fragments;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PUBLIC_DOCUMENTATION = {
  "@dougongjs/reactive": [
    ["Chinese", ["docs/guide/reactive.md"]],
    ["English", ["docs/en/guide/reactive.md"]],
  ],
  "@dougongjs/core": [
    ["Chinese", ["docs/reference/core-api.md", "docs/reference/errors.md"]],
    ["English", ["docs/en/reference/core-api.md", "docs/en/reference/errors.md"]],
  ],
  "@dougongjs/platform": [
    ["Chinese", ["docs/reference/platform.md", "docs/reference/errors.md"]],
    ["English", ["docs/en/reference/platform.md", "docs/en/reference/errors.md"]],
  ],
};

for (const [packageName, languages] of Object.entries(PUBLIC_DOCUMENTATION)) {
  const surface = surfaces.get(packageName);
  if (!surface) continue;
  const exported = [...surface.values, ...surface.types];
  for (const [language, docs] of languages) {
    const documented = new Set(
      docs.flatMap((doc) =>
        markdownCode(readFileSync(doc, "utf8")).flatMap((code) =>
          [...code.matchAll(/[$A-Z_a-z][$\w]*/g)].map(([name]) => name),
        ),
      ),
    );
    for (const name of exported) {
      if (!documented.has(name)) {
        failures.push(`${packageName}: ${language} documentation omits public export '${name}'`);
      }
    }
  }
}

if (failures.length) {
  console.error("Public API surface guard failed:\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error("\nObserved surface:");
  for (const [name, surface] of surfaces) {
    console.error(`\n  ${name}`);
    console.error(`    values: ${surface.values.join(", ") || "(none)"}`);
    console.error(`    types:  ${surface.types.join(", ") || "(none)"}`);
  }
  process.exit(1);
}

const codeCount = sourceCodes.size;
const total = [...surfaces.values()].reduce(
  (sum, surface) => sum + surface.values.length + surface.types.length,
  0,
);
console.log(
  `Public API surface OK (${total} exported identifiers, ${codeCount} error codes, ${surfaces.size} packages)`,
);
