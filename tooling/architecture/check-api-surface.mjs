#!/usr/bin/env node
// Inspect emitted declarations because runtime export checks cannot see type-only exports or inferred any.

import PACKAGES from "./public-api.json" with { type: "json" };
import { pathToFileURL } from "node:url";
import typescript from "typescript";
import { declarationSurface } from "./declaration-surface.mjs";
import { constructedErrorCode, errorDocumentationFailures } from "./error-code-surface.mjs";
import { existsSync, globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { loadConfigFromFile } from "vite";
import { abbreviatedDeclaration, retiredVocabulary } from "./vocabulary.mjs";
import { packageEntrypoints, publishedDirectories } from "../packages.mjs";
import { architectureRules, sourceExtensions } from "./rules.mjs";
import { runtimeBaseline } from "../runtime-baseline.mjs";

const retiredIdentifiers = new Set(retiredVocabulary);

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
  if (JSON.stringify(manifest.engines) !== JSON.stringify(runtimeBaseline.engines)) {
    failures.push(`${manifestPath}: engines differs from tooling/runtime-baseline.mjs`);
  }
}
for (const documentPath of [
  "README.md",
  "README.en.md",
  "docs/guide/getting-started.md",
  "docs/en/guide/getting-started.md",
  "docs/guide/migrating-to-0.9.md",
  "docs/en/guide/migrating-to-0.9.md",
  "packages/dougong/README.md",
  "packages/reactive/README.md",
]) {
  if (!readFileSync(documentPath, "utf8").includes(`Node.js \`${runtimeBaseline.engines.node}\``))
    failures.push(`${documentPath}: Node.js range differs from tooling/runtime-baseline.mjs`);
}
for (const manifestPath of ["package.json", ...publishedManifestPaths]) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (JSON.stringify(manifest.browserslist) !== JSON.stringify(runtimeBaseline.browserslist)) {
    failures.push(`${manifestPath}: browserslist differs from tooling/runtime-baseline.mjs`);
  }
}
for (const directory of [...publishedDirectories, "examples"]) {
  const configurationPath = `${directory}/vite.config.ts`;
  const configuration = await loadConfigFromFile(
    { command: "build", mode: "production" },
    resolve(configurationPath),
    resolve(directory),
  );
  if (!isDeepStrictEqual(configuration?.config.build?.target, runtimeBaseline.buildTargets)) {
    failures.push(`${configurationPath}: emitted syntax does not use the shared runtime baseline`);
  }
}
for (const directory of publishedDirectories) {
  const manifest = JSON.parse(readFileSync(`${directory}/package.json`, "utf8"));
  for (const { specifier, types, module } of packageEntrypoints(manifest)) {
    if (!Object.hasOwn(PACKAGES, specifier))
      failures.push(`${specifier}: undeclared public entrypoint`);
    for (const target of [types, module]) {
      if (!existsSync(resolve(directory, target)))
        failures.push(`${specifier}: missing exported file ${target}`);
    }
    if (Object.hasOwn(PACKAGES, specifier) && existsSync(resolve(directory, module))) {
      const exports = await import(pathToFileURL(resolve(directory, module)).href);
      const { added, missing } = difference(Object.keys(exports), PACKAGES[specifier].values);
      for (const name of added) failures.push(`${specifier}: undeclared runtime export '${name}'`);
      for (const name of missing) failures.push(`${specifier}: missing runtime export '${name}'`);
    }
    if (existsSync(resolve(directory, types)))
      surfaces.set(specifier, declarationSurface(resolve(directory, types)));
  }
}
for (const name of Object.keys(PACKAGES)) {
  if (!surfaces.has(name)) failures.push(`${name}: missing public entrypoint or declaration`);
}

for (const file of publishedDirectories.flatMap((directory) =>
  globSync(`${directory}/dist/**/*.d.{ts,mts,cts}`),
)) {
  const source = typescript.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    typescript.ScriptTarget.Latest,
    true,
    typescript.ScriptKind.TS,
  );
  const visit = (node) => {
    const abbreviated = abbreviatedDeclaration(node);
    if (abbreviated) failures.push(`${file}: ${abbreviated}`);
    if (typescript.isIdentifier(node) && retiredIdentifiers.has(node.text))
      failures.push(
        `${file}: retired identifier '${node.text}' appears in its declaration surface`,
      );
    if (node.kind === typescript.SyntaxKind.AnyKeyword) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      failures.push(`${file}:${line}: declaration surface contains an any type`);
    }
    typescript.forEachChild(node, visit);
  };
  visit(source);
}

for (const [name, expectedSurface] of Object.entries(PACKAGES)) {
  const surface = surfaces.get(name);
  if (!surface) continue;

  if (expectedSurface.values && expectedSurface.types) {
    for (const [kind, expected] of [
      ["value", expectedSurface.values],
      ["type", expectedSurface.types],
    ]) {
      const { added, missing } = difference(surface[`${kind}s`], expected);
      for (const item of added) failures.push(`${name}: undeclared ${kind} export '${item}'`);
      for (const item of missing) failures.push(`${name}: missing ${kind} export '${item}'`);
    }
  }
}

const ERROR_CODE_PATTERN = /^[A-Z][A-Z_]{3,}$/;
const sourceCodes = new Set();
for (const directory of ["packages/dougong/src", "packages/platform/src"]) {
  for (const file of globSync(`${directory}/**/*.{${sourceExtensions.join(",")}}`)) {
    const source = typescript.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      typescript.ScriptTarget.Latest,
      true,
      typescript.ScriptKind.TS,
    );
    const visit = (node) => {
      if (typescript.isStringLiteralLike(node) && ERROR_CODE_PATTERN.test(node.text)) {
        const parent = node.parent;
        const isDeclaredCode =
          typescript.isLiteralTypeNode(parent) &&
          typescript.isUnionTypeNode(parent.parent) &&
          typescript.isTypeAliasDeclaration(parent.parent.parent) &&
          parent.parent.parent.name.text === "PlatformErrorCode";
        const isErrorConstruction =
          parent.arguments?.[0] === node && constructedErrorCode(parent) !== undefined;
        const isErrorSubclass =
          typescript.isCallExpression(parent) &&
          parent.arguments[0] === node &&
          parent.expression.kind === typescript.SyntaxKind.SuperKeyword;
        const isTransitionFailure =
          typescript.isCallExpression(parent) &&
          parent.arguments[0] === node &&
          typescript.isPropertyAccessExpression(parent.expression) &&
          parent.expression.name.text === "#transitionError";
        const isFailureNormalization =
          typescript.isCallExpression(parent) &&
          parent.arguments[1] === node &&
          typescript.isIdentifier(parent.expression) &&
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
      typescript.forEachChild(node, visit);
    };
    visit(source);
  }
}
// Check all pages so retired error codes cannot survive outside the canonical reference table.
const MARKDOWN_FILES = [
  ...globSync("docs/**/*.md"),
  ...globSync("packages/*/README.md"),
  "examples/README.md",
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

const retiredDocumentationPatterns = [...retiredIdentifiers].map((term) => [
  term,
  new RegExp(`(?<![\\w$-])${escapeRegExp(term)}(?![\\w$-])`),
]);

for (const documentPath of MARKDOWN_FILES) {
  if (documentPath.includes(".vitepress")) continue;
  const text = readFileSync(documentPath, "utf8");
  const code = markdownCode(text).join("\n");
  for (const [term, pattern] of retiredDocumentationPatterns) {
    if (pattern.test(code)) failures.push(`${documentPath}: uses retired code term '${term}'`);
  }
  for (const failure of errorDocumentationFailures(documentPath, text, sourceCodes))
    failures.push(`${documentPath}: ${failure}`);
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
    (_block, _fence, languageTag, code) => {
      if (/^\s*(?:[cm]?[jt]sx?|typescript|javascript|json)\b/i.test(languageTag)) {
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
  for (const [language, documentPaths] of languages) {
    const documented = new Set(
      documentPaths.flatMap((documentPath) =>
        markdownCode(readFileSync(documentPath, "utf8")).flatMap((code) =>
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
