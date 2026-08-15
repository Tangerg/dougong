#!/usr/bin/env node
// Public declaration guard. Complements check-layers.mjs (import direction) and
// the runtime `api-surface.test.ts` (which can only see values): this one reads
// the *built* `dist/index.d.ts` of every published package and asserts the exact
// exported vocabulary, values and types alike.
//
// Two independent assertions per package:
//
//   1. The exported identifiers equal the allowlist exactly. A new export is a
//      deliberate decision, not a side effect of an `export *`.
//   2. No retired identifier reappears anywhere on the public surface. The
//      banlist holds whole tokens, never patterns, so `Plugin`, `PluginContext`,
//      `PluginMeta`, `definePlugin` and the `PLUGIN_*` error codes stay legal
//      while `PluginHandle` and friends cannot come back.
//
// Symbols are resolved through the TypeScript checker rather than matched as
// text, so `export *` re-exports are seen as the final surface a consumer gets.
//
// Run after `pnpm build`; `dist/index.d.ts` is the only place the full type
// surface exists as an artifact.

import { createRequire } from "node:module";
import { existsSync, globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ts = createRequire(import.meta.url)("typescript");

// The vocabulary. One name per lifecycle stage:
//
//   Manifest + Reference -> Artifact -> Registration   (Platform: external code)
//   Plugin -> Installation -> Runtime                  (Core: installed code)
//
// Host is the runtime boundary Dougong owns. The code that embeds Dougong is
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
      "PluginMeta",
      "ProvidedServices",
      "Provisions",
      "Requirements",
      "ResolvedRequirement",
      "ResolvedRequirements",
      // The runtime boundary and what lives inside it.
      "ChangeSet",
      "Group",
      "GroupSnapshot",
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

// Identifiers retired by the vocabulary rebuild. Whole tokens only.
const RETIRED = [
  // Core: the runtime boundary was called an Application.
  "Application",
  "ApplicationSnapshot",
  "ApplicationStatus",
  "CreateAppOptions",
  "createApp",
  // Core: an installation was an untyped handle, a plugin was a "definition".
  "InstallationHandle",
  "PluginChangeSet",
  "PluginContainer",
  "PluginDefinition",
  "PluginGroup",
  "PluginHandle",
  "PluginSnapshot",
  "PluginUpdate",
  // Core: an extension point was an "extension"; its view was over the point.
  "Extension",
  "ExtensionRequirementView",
  "ExtensionView",
  "extension",
  // Platform: every stage was called a plugin.
  "CreatePlatformOptions",
  "ImportPluginLoader",
  "ManagedPlugin",
  "ManagedPluginSnapshot",
  "ManagedPluginStatus",
  "MemoryPluginLoader",
  "PermissionAuthorizer",
  "PluginArtifact",
  "PluginLoader",
  "PluginManifest",
  "PluginManifestInput",
  "PluginPlatform",
  "PluginPlatformSnapshot",
  "PluginPlatformStatus",
];

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
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const symbol =
      exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    // A class is both; classify it as a value so each name lands in exactly one
    // bucket and the two allowlists stay disjoint.
    if (symbol.flags & ts.SymbolFlags.Value) values.add(exported.name);
    else if (symbol.flags & ts.SymbolFlags.Type) types.add(exported.name);
    else throw new Error(`${distPath} exports '${exported.name}' with no value or type meaning`);
  }
  return { values: [...values].sort(), types: [...types].sort() };
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

  for (const kind of ["values", "types"]) {
    for (const item of surface[kind]) {
      if (RETIRED.includes(item)) {
        failures.push(`${name}: retired identifier '${item}' is public again`);
      }
    }
  }
}

// The facade must be exactly Core + Platform + the forwarded reactive names, and
// nothing of its own. Checked against the parsed surfaces, not the source text.
const facade = surfaces.get("dougong");
const core = surfaces.get("@dougongjs/core");
const platform = surfaces.get("@dougongjs/platform");
const reactive = surfaces.get("@dougongjs/reactive");
if (facade && core && platform && reactive) {
  const upstream = new Set([
    ...core.values,
    ...core.types,
    ...platform.values,
    ...platform.types,
    ...reactive.values,
    ...reactive.types,
  ]);
  for (const kind of ["values", "types"]) {
    for (const item of facade[kind]) {
      if (!upstream.has(item)) {
        failures.push(`dougong: facade declares '${item}' that no upstream package exports`);
      }
    }
  }
  for (const item of [...core.values, ...platform.values]) {
    if (!facade.values.includes(item)) {
      failures.push(`dougong: facade does not re-export the value '${item}'`);
    }
  }
  for (const item of [...core.types, ...platform.types]) {
    if (!facade.types.includes(item)) {
      failures.push(`dougong: facade does not re-export the type '${item}'`);
    }
  }
}

// Error codes are public API too, and the only copy of them a consumer reads is
// the reference table. Derive the real set from source and require both language
// versions to list exactly it — so "25 stable codes" can never go stale by hand.
const CODE_RE = /"([A-Z][A-Z_]{3,})"/g;
const IGNORED_CONSTANTS = new Set(["AbortError"]);
const sourceCodes = new Set();
for (const dir of ["packages/core/src", "packages/platform/src"]) {
  for (const file of globSync(`${dir}/*.ts`)) {
    for (const [, code] of readFileSync(file, "utf8").matchAll(CODE_RE)) {
      if (!IGNORED_CONSTANTS.has(code)) sourceCodes.add(code);
    }
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
