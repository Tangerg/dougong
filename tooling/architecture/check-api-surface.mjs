#!/usr/bin/env node
// Inspect emitted declarations because runtime export checks cannot see type-only exports or inferred any.

import { createRequire } from "node:module";
import { existsSync, globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { retiredVocabulary } from "./vocabulary.mjs";
import { publishedDirectories } from "../packages.mjs";
import { architectureRules } from "./rules.mjs";
import { developmentEngines, runtimeBaseline } from "../runtime-baseline.mjs";

const ts = createRequire(import.meta.url)("typescript");
const retiredIdentifiers = new Set(retiredVocabulary);

const PACKAGES = {
  "@dougongjs/reactive": {
    dist: "packages/reactive/dist/index.d.ts",
    values: ["batch", "bridge", "computed", "observe", "signal"],
    types: [
      "AsyncDisposable",
      "Disposable",
      "BridgeOwner",
      "ObservationOwner",
      "ObservationTask",
      "Observer",
      "Readable",
      "ReadonlySignal",
      "Signal",
    ],
  },
  dougong: {
    dist: "packages/dougong/dist/index.d.ts",
    values: [
      "ConfigValidationError",
      "DougongError",
      "RecordedFailure",
      "asyncDisposeSymbol",
      "captureConfig",
      "createHost",
      "definePlugin",
      "describePlugin",
      "disposeSymbol",
      "event",
      "extensionPoint",
      "isCancellationReason",
      "isError",
      "isLogger",
      "optional",
      "service",
    ],
    types: [
      "ContractKind",
      "ContractValue",
      "Event",
      "ExtensionPoint",
      "OptionalService",
      "Requirement",
      "Service",
      "AnyPlugin",
      "Awaitable",
      "Plugin",
      "PluginContext",
      "PluginDescriptor",
      "PluginConfigDescriptor",
      "PluginDescriptionOptions",
      "InstanceMeta",
      "ProvidedServices",
      "Provisions",
      "Requirements",
      "ResolvedRequirement",
      "ResolvedRequirements",
      "ApplyResult",
      "ChangeSet",
      "Group",
      "GroupSnapshot",
      "Host",
      "HostOptions",
      "HostSnapshot",
      "HostStatus",
      "InitialInstallation",
      "Installation",
      "InstallationOptions",
      "InstallationOrigin",
      "InstallationSnapshot",
      "InstallationState",
      "InstallationUpdate",
      "ConfigValue",
      "Plan",
      "PlanReport",
      "BindingReport",
      "ImpactReason",
      "PlanOperation",
      "DeclarationSnapshot",
      "AsyncDisposable",
      "BackgroundTask",
      "Cleanup",
      "Disposable",
      "LifetimeContext",
      "LifetimeOwnership",
      "LifetimePhase",
      "LifetimeSnapshot",
      "Task",
      "UnresolvedObligation",
      "Resource",
      "Contribution",
      "ContributionView",
      "ContributionOperations",
      "EventListener",
      "EventArguments",
      "EventOperations",
      "Logger",
      "SnapshotView",
      "ErrorSnapshot",
      "ErrorDetails",
    ],
  },
  "dougong/advanced": {
    dist: "packages/dougong/dist/advanced.d.ts",
    values: [
      "SnapshotPublisher",
      "ReadonlyMapSnapshot",
      "SerialQueue",
      "normalizePlainRecord",
      "batchSnapshotNotifications",
    ],
    types: [],
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
      "ArtifactInput",
      "ArtifactDescriptor",
      "ArtifactOrigin",
      "Catalog",
      "Authorizer",
      "AdmissionRequest",
      "Loader",
      "Manifest",
      "ManifestInput",
      "Platform",
      "PlatformOptions",
      "PlatformSnapshot",
      "PlatformStatus",
      "PlatformErrorCode",
      "Registration",
      "RegistrationSnapshot",
      "RegistrationStatus",
      "ActivationOptions",
      "ActivationPreviewOptions",
      "ActivationPreview",
      "ActivationBlocker",
    ],
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
    // Classify classes as values so type and value allowlists stay disjoint.
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

const publishedManifestPaths = publishedDirectories.map((directory) => `${directory}/package.json`);
const runtimeManifestPaths = ["package.json", ...publishedManifestPaths, "examples/package.json"];
for (const manifestPath of runtimeManifestPaths) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const engines = manifestPath === "package.json" ? developmentEngines : runtimeBaseline.engines;
  if (JSON.stringify(manifest.engines) !== JSON.stringify(engines)) {
    failures.push(`${manifestPath}: engines differs from tooling/runtime-baseline.mjs`);
  }
}
for (const manifestPath of ["package.json", ...publishedManifestPaths]) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (JSON.stringify(manifest.browserslist) !== JSON.stringify(runtimeBaseline.browserslist)) {
    failures.push(`${manifestPath}: browserslist differs from tooling/runtime-baseline.mjs`);
  }
}
for (const directory of [...publishedDirectories, "examples"]) {
  const configPath = `${directory}/vite.config.ts`;
  const config = readFileSync(configPath, "utf8");
  const relativeBaseline =
    directory === "examples"
      ? "../tooling/runtime-baseline.mjs"
      : "../../tooling/runtime-baseline.mjs";
  if (
    !config.includes(relativeBaseline) ||
    !config.includes("target: runtimeBaseline.buildTargets")
  ) {
    failures.push(`${configPath}: emitted syntax does not use the shared runtime baseline`);
  }
}
for (const manifestPath of publishedManifestPaths) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const expected = manifest.name === "dougong" ? [".", "./advanced"] : ["."];
  const { added, missing } = difference(Object.keys(manifest.exports), expected);
  for (const key of added) failures.push(`${manifestPath}: undeclared package subpath '${key}'`);
  for (const key of missing) failures.push(`${manifestPath}: missing package subpath '${key}'`);
  for (const [key, entry] of Object.entries(manifest.exports)) {
    if (!entry.types?.endsWith(".d.ts") || !entry.import?.endsWith(".js"))
      failures.push(`${manifestPath}: '${key}' requires types and ESM import targets`);
  }
}

for (const [name, spec] of Object.entries(PACKAGES)) {
  if (!existsSync(resolve(spec.dist))) {
    failures.push(`${name}: ${spec.dist} is missing — run \`pnpm build\` first`);
    continue;
  }
  surfaces.set(name, surfaceOf(spec.dist));
}

for (const file of publishedDirectories.flatMap((directory) =>
  globSync(`${directory}/dist/**/*.d.ts`),
)) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      failures.push(`${file}:${line}: declaration surface contains an any type`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
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

const ERROR_CODE_RE = /^[A-Z][A-Z_]{3,}$/;
const sourceCodes = new Set();
for (const dir of ["packages/dougong/src", "packages/platform/src"]) {
  for (const file of globSync(`${dir}/**/*.ts`)) {
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
        const isDeclaredCode =
          ts.isLiteralTypeNode(parent) &&
          ts.isUnionTypeNode(parent.parent) &&
          ts.isTypeAliasDeclaration(parent.parent.parent) &&
          parent.parent.parent.name.text === "PlatformErrorCode";
        const isErrorConstruction =
          ts.isNewExpression(parent) &&
          parent.arguments?.[0] === node &&
          ts.isIdentifier(parent.expression) &&
          (parent.expression.text === "DougongError" || parent.expression.text === "PlatformError");
        const isErrorSubclass =
          ts.isCallExpression(parent) &&
          parent.arguments[0] === node &&
          parent.expression.kind === ts.SyntaxKind.SuperKeyword;
        const isTransitionFailure =
          ts.isCallExpression(parent) &&
          parent.arguments[0] === node &&
          ts.isPropertyAccessExpression(parent.expression) &&
          parent.expression.name.text === "#transitionError";
        const isFailureNormalization =
          ts.isCallExpression(parent) &&
          parent.arguments[1] === node &&
          ts.isIdentifier(parent.expression) &&
          parent.expression.text === "normalizeFailure";
        if (
          isDeclaredCode ||
          isErrorConstruction ||
          isErrorSubclass ||
          isTransitionFailure ||
          isFailureNormalization
        ) {
          sourceCodes.add(node.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}
// Check all pages so retired error codes cannot survive outside the canonical reference table.
const REFERENCE_TABLES = ["docs/reference/errors.md", "docs/en/reference/errors.md"];
const MARKDOWN_FILES = [
  ...globSync("docs/**/*.md"),
  ...globSync("packages/*/README.md"),
  "README.md",
  "README.en.md",
];

// Derive navigation from Markdown pages so a second inventory cannot silently drift.
const navigationSource = readFileSync("docs/.vitepress/config.mts", "utf8");
const configuredRoutes = [...navigationSource.matchAll(/\blink:\s*"([^"]+)"/g)].map(
  ([, route]) => route.split("#", 1)[0],
);
for (const locale of [
  {
    name: "Chinese",
    prefix: "",
    home: "docs/index.md",
    pages: ["docs/guide/*.md", "docs/reference/*.md", "docs/examples.md"],
  },
  {
    name: "English",
    prefix: "en/",
    home: "docs/en/index.md",
    pages: ["docs/en/guide/*.md", "docs/en/reference/*.md", "docs/en/examples.md"],
  },
]) {
  const expected = new Set(
    locale.pages
      .flatMap((pattern) => globSync(pattern))
      .map((file) => `/${file.slice("docs/".length, -".md".length)}`),
  );
  const sidebar = new Set(
    configuredRoutes.filter(
      (route) =>
        route.startsWith(`/${locale.prefix}guide/`) ||
        route.startsWith(`/${locale.prefix}reference/`) ||
        route === `/${locale.prefix}examples`,
    ),
  );
  const homepage = new Set(
    [...readFileSync(locale.home, "utf8").matchAll(/\]\(\.\/([^\s)#]+\.md)(?:#[^)]*)?\)/g)].map(
      ([, target]) => `/${locale.prefix}${target.slice(0, -".md".length)}`,
    ),
  );
  for (const [surface, routes] of [
    ["sidebar", sidebar],
    ["homepage", homepage],
  ]) {
    for (const route of expected) {
      if (!routes.has(route)) failures.push(`${locale.name} ${surface}: omits '${route}'`);
    }
    for (const route of routes) {
      if (!expected.has(route)) failures.push(`${locale.name} ${surface}: stale route '${route}'`);
    }
  }
}

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

const GUARD_PAGES = ["docs/reference/guards.md", "docs/en/reference/guards.md"];
for (const page of GUARD_PAGES) {
  const documented = new Set(
    [...readFileSync(page, "utf8").matchAll(/^\| `([^`]+)` \|/gm)].map(([, id]) => id),
  );
  for (const id of architectureRules)
    if (!documented.has(id)) failures.push(`${page}: architecture rule '${id}' is not documented`);
  for (const id of documented)
    if (!architectureRules.has(id)) failures.push(`${page}: obsolete architecture rule '${id}'`);
}

const coverageSource = readFileSync("vitest.config.ts", "utf8");
const coverageThresholds = new Map();
for (const match of coverageSource.matchAll(
  /"packages\/(dougong|platform|reactive)\/src\/\*\*":\s*\{([^}]+)\}/g,
)) {
  const [, packageName, body] = match;
  const values = Object.fromEntries(
    [...body.matchAll(/(statements|branches|functions|lines):\s*(\d+)/g)].map(([, key, value]) => [
      key,
      Number(value),
    ]),
  );
  coverageThresholds.set(packageName, values);
}
for (const packageName of ["dougong", "platform", "reactive"]) {
  const values = coverageThresholds.get(packageName);
  if (!values || Object.keys(values).length !== 4) {
    failures.push(`vitest.config.ts: cannot derive ${packageName} coverage thresholds`);
    continue;
  }
  const expectedRow = `| ${packageName} | ${values.statements} | ${values.branches} | ${values.functions} | ${values.lines} |`;
  for (const page of GUARD_PAGES) {
    if (!readFileSync(page, "utf8").includes(expectedRow)) {
      failures.push(`${page}: coverage row for ${packageName} differs from vitest.config.ts`);
    }
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
  dougong: [
    ["Chinese", ["docs/reference/core-api.md", "docs/reference/errors.md"]],
    ["English", ["docs/en/reference/core-api.md", "docs/en/reference/errors.md"]],
  ],
  "dougong/advanced": [
    ["Chinese", ["docs/reference/core-api.md"]],
    ["English", ["docs/en/reference/core-api.md"]],
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
  `Public API surface OK (${total} exported identifiers, ${codeCount} error codes, ${surfaces.size} entrypoints)`,
);
