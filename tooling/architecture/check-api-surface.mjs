#!/usr/bin/env node
// Inspect emitted declarations because runtime export checks cannot see type-only exports or inferred any.

import PACKAGES from "./public-api.json" with { type: "json" };
import { pathToFileURL } from "node:url";
import typescript from "typescript";
import { declarationSurface } from "./declaration-surface.mjs";
import { sourceErrorCodes, errorDocumentationFailures } from "./error-code-surface.mjs";
import { existsSync, globSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { loadConfigFromFile } from "vite";
import {
  createMarkdownRenderer,
  disposeMdItInstance,
  resolveConfig as resolveDocumentationConfiguration,
} from "vitepress";
import { resolveConfig as resolveTestConfiguration } from "vitest/node";
import { documentationTarget, MarkdownDocument } from "./markdown-document.mjs";
import { coverageDocumentationFailures, sidebarRoutes } from "./configuration-surface.mjs";
import { abbreviatedDeclaration, retiredVocabulary } from "./vocabulary.mjs";
import { packageEntrypoints, publishedDirectories } from "../packages.mjs";
import { architectureRules, sourceExtensions } from "./rules.mjs";
import { runtimeBaseline } from "../runtime-baseline.mjs";
import { runtimeProjectionChanges } from "../runtime-projections.mjs";

const retiredIdentifiers = new Set(retiredVocabulary);
const publicImports = Object.keys(PACKAGES);

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

for (const { path } of runtimeProjectionChanges(
  new URL("./", pathToFileURL(resolve("package.json"))),
))
  failures.push(
    `${path}: runtime projection differs from tooling/runtime-baseline.mjs; run pnpm generate:runtime`,
  );
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
    const abbreviated = abbreviatedDeclaration(node, publicImports);
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

const sourceConfiguration = typescript.getParsedCommandLineOfConfigFile(
  "tsconfig.base.json",
  { noEmit: true },
  {
    ...typescript.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new TypeError(typescript.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  },
);
if (!sourceConfiguration || sourceConfiguration.errors.length)
  throw new TypeError("Cannot read the source compiler configuration");
const sourceProgram = typescript.createProgram(
  ["packages/dougong/src", "packages/platform/src"].flatMap((directory) =>
    globSync(`${directory}/**/*.{${sourceExtensions.join(",")}}`),
  ),
  sourceConfiguration.options,
);
const sourceCodes = sourceErrorCodes(
  sourceProgram,
  "packages/dougong/src/index.ts",
  "DougongError",
);
// Check all pages so retired error codes cannot survive outside the canonical reference table.
const MARKDOWN_FILES = [
  ...globSync("docs/**/*.md"),
  ...globSync("packages/*/README.md"),
  "examples/README.md",
  "README.md",
  "README.en.md",
];

const documentationConfiguration = await resolveDocumentationConfiguration(
  resolve("docs"),
  "build",
  "production",
);
const renderer = await createMarkdownRenderer(
  documentationConfiguration.srcDir,
  documentationConfiguration.markdown,
  documentationConfiguration.site.base,
  documentationConfiguration.logger,
  documentationConfiguration.publicDir,
);
const documents = new Map(
  MARKDOWN_FILES.filter((path) => !path.includes(".vitepress")).map((path) => [
    path,
    new MarkdownDocument(renderer, readFileSync(path, "utf8"), {
      path: resolve(path),
      relativePath: relative(documentationConfiguration.srcDir, resolve(path)),
    }),
  ]),
);

// Derive navigation from Markdown pages so a second inventory cannot silently drift.
for (const locale of [
  {
    key: "root",
    name: "Chinese",
    prefix: "",
    home: "docs/index.md",
    pages: ["docs/guide/*.md", "docs/reference/*.md", "docs/examples.md"],
  },
  {
    key: "en",
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
  const configuration = documentationConfiguration.site.locales[locale.key].themeConfig;
  const configuredSidebar =
    configuration?.sidebar ?? documentationConfiguration.site.themeConfig.sidebar;
  const sidebar = new Set();
  for (const route of expected) {
    const routes = sidebarRoutes(configuredSidebar, route);
    if (!routes.has(route)) failures.push(`${locale.name} sidebar: omits '${route}'`);
    for (const target of routes) sidebar.add(target);
  }
  const homepage = new Set(
    documents
      .get(locale.home)
      .links()
      .map(({ target }) => documentationTarget(locale.home, target))
      .filter((target) => target?.startsWith("/docs/"))
      .map((target) => target.slice("/docs".length, -".md".length)),
  );
  for (const [surface, routes] of [
    ["sidebar", sidebar],
    ["homepage", homepage],
  ]) {
    for (const route of expected) {
      if (surface === "homepage" && !routes.has(route))
        failures.push(`${locale.name} ${surface}: omits '${route}'`);
    }
    for (const route of routes) {
      if (
        (route.startsWith(`/${locale.prefix}guide/`) ||
          route.startsWith(`/${locale.prefix}reference/`) ||
          route === `/${locale.prefix}examples`) &&
        !expected.has(route)
      )
        failures.push(`${locale.name} ${surface}: stale route '${route}'`);
    }
  }
}

const retiredDocumentationPatterns = [...retiredIdentifiers].map((term) => [
  term,
  new RegExp(`(?<![\\w$-])${escapeRegExp(term)}(?![\\w$-])`),
]);

for (const [documentPath, document] of documents) {
  const code = document.codeFragments().join("\n");
  for (const [term, pattern] of retiredDocumentationPatterns) {
    if (pattern.test(code)) failures.push(`${documentPath}: uses retired code term '${term}'`);
  }
  for (const failure of errorDocumentationFailures(documentPath, document, sourceCodes))
    failures.push(`${documentPath}: ${failure}`);
}

const GUARD_PAGES = ["docs/reference/guards.md", "docs/en/reference/guards.md"];
for (const page of GUARD_PAGES) {
  const documented = new Set(
    documents
      .get(page)
      .tableRows()
      .flatMap((row) => row[0]?.codes ?? []),
  );
  for (const id of architectureRules)
    if (!documented.has(id)) failures.push(`${page}: architecture rule '${id}' is not documented`);
  for (const id of documented)
    if (!architectureRules.has(id)) failures.push(`${page}: obsolete architecture rule '${id}'`);
}

const testConfiguration = await resolveTestConfiguration();
for (const directory of publishedDirectories) {
  for (const page of GUARD_PAGES) {
    for (const failure of coverageDocumentationFailures(
      testConfiguration.test.coverage.thresholds,
      directory,
      documents.get(page),
    ))
      failures.push(`${page}: ${failure}`);
  }
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
        documents
          .get(documentPath)
          .codeFragments()
          .flatMap((code) => [...code.matchAll(/[$A-Z_a-z][$\w]*/g)].map(([name]) => name)),
      ),
    );
    for (const name of exported) {
      if (!documented.has(name)) {
        failures.push(`${packageName}: ${language} documentation omits public export '${name}'`);
      }
    }
  }
}

disposeMdItInstance();

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
