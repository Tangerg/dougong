#!/usr/bin/env node
// Public declaration guard. Complements check-layers.mjs (import direction) and
// the value-level `api-surface.test.ts` (which cannot see type-only exports):
// this one reads the *built* `dist/index.d.ts` of every published package and asserts the exact
// exported vocabulary, values and types alike.
//
// Two independent assertions per package:
//
//   1. The exported identifiers equal the allowlist exactly. A new export is a
//      deliberate decision, not a side effect of an `export *`.
//   2. No retired identifier reappears in a package entry declaration. The
//      banlist holds whole tokens, never patterns, so `Plugin`, `PluginContext`,
//      `InstanceMeta`, `definePlugin` and other valid Plugin-related names
//      stay legal while `PluginHandle` and friends cannot come back.
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
      "GroupStatus",
      "Host",
      "HostOptions",
      "HostSnapshot",
      "HostStatus",
      "Installation",
      "InstallationSnapshot",
      "InstallationStatus",
      "InstallationUpdate",
      "Installer",
      // Ownership.
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
for (const doc of [...globSync("docs/**/*.md"), "README.md", "README.en.md"]) {
  if (doc.includes(".vitepress")) continue;
  const text = readFileSync(doc, "utf8");
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
