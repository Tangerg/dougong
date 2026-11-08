#!/usr/bin/env node

import { globSync, readFileSync } from "node:fs";
import { sep } from "node:path";
import typescript from "typescript";
import { packageEntrypoints, publishedDirectories } from "../packages.mjs";
import { analyzeDependencies, compilerOptions } from "./analyze-dependencies.mjs";
import { ModuleImportPolicy } from "./module-import-policy.mjs";
import { architectureRules, sourceExtensions } from "./rules.mjs";
import {
  DeclarationOwnership,
  inspectDeclarationContracts,
  inspectRuntimeEffects,
  inspectVocabulary,
} from "./source-policy.mjs";
import { abbreviatedDeclaration } from "./vocabulary.mjs";

const packageDependencies = {
  dougong: new Set(),
  reactive: new Set(),
  platform: new Set(["dougong"]),
  examples: new Set(["dougong", "reactive", "platform"]),
};

const moduleDependencies = {
  dougong: {
    public: [
      "contracts",
      "internal",
      "observation",
      "lifetime",
      "events",
      "contributions",
      "composition",
      "inspection",
      "execution",
    ],
    internal: [],
    contracts: ["internal"],
    observation: ["contracts", "internal"],
    lifetime: ["contracts", "internal", "observation"],
    events: ["contracts", "internal", "lifetime"],
    contributions: ["contracts", "internal", "lifetime", "observation"],
    composition: ["contracts", "internal", "lifetime", "events", "contributions", "observation"],
    inspection: ["contracts", "internal", "lifetime", "composition", "observation"],
    execution: [
      "contracts",
      "internal",
      "lifetime",
      "events",
      "contributions",
      "composition",
      "inspection",
      "observation",
    ],
  },
  reactive: {},
  platform: {
    public: ["artifacts", "loaders", "admission", "catalog", "activation", "errors"],
    errors: [],
    artifacts: ["errors"],
    loaders: ["artifacts", "errors"],
    admission: ["artifacts", "errors"],
    catalog: ["artifacts", "errors"],
    activation: ["artifacts", "admission", "loaders", "catalog", "errors"],
  },
};

const publicImports = new Set(
  publishedDirectories.flatMap((directory) =>
    packageEntrypoints(JSON.parse(readFileSync(`${directory}/package.json`, "utf8"))).map(
      (entry) => entry.specifier,
    ),
  ),
);
const failures = [];
const options = compilerOptions();
const graph = (await analyzeDependencies(options)).obj();
const program = typescript.createProgram(Object.keys(graph), options);
const checker = program.getTypeChecker();
const moduleImportPolicy = new ModuleImportPolicy(checker, options, publicImports, process.cwd());
const declarationOwnership = new DeclarationOwnership(program);

function location(path) {
  if (path.startsWith("examples/")) return { package: "examples", module: undefined };
  const match = /^packages\/([^/]+)\/src\/(.+)$/.exec(path);
  if (!match) return undefined;
  const [, name, relative] = match;
  const module = relative.includes("/")
    ? relative.split("/")[0]
    : name === "reactive"
      ? undefined
      : relative === "index.ts" || relative === "advanced.ts"
        ? "public"
        : relative === "errors.ts" && name === "platform"
          ? "errors"
          : "undeclared";
  return { package: name, module };
}

function violation(file, rule, message, node, source) {
  if (!architectureRules.has(rule)) throw new Error(`Unknown architecture rule ${rule}`);
  const line = node
    ? ":" + (source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1)
    : "";
  failures.push(`${file}${line}: [${rule}] ${message}`);
}

for (const [file, dependencies] of Object.entries(graph)) {
  if (!sourceExtensions.some((extension) => file.endsWith(`.${extension}`))) continue;
  const source = program.getSourceFile(file);
  const text = source.text;
  const owner = location(file);
  const test = /\/test\//.test(file);
  const typedAssertions = file.endsWith("/public-api.types.ts");
  const sourceContext = Object.freeze({ file, source, owner, test, typedAssertions });
  const report = (rule, message, node) => violation(file, rule, message, node, source);
  if (/@ts-(?:ignore|nocheck)\b/.test(text))
    violation(file, "types.suppressions", "silent TypeScript suppressions are forbidden");
  if (/@ts-expect-error\b/.test(text) && !typedAssertions)
    violation(file, "types.suppressions", "expected type errors belong in public-api.types.ts");

  if (owner) {
    if (!Object.hasOwn(packageDependencies, owner.package))
      violation(file, "ownership.package", "source package has no declared responsibility");
    const boundaries = moduleDependencies[owner.package];
    if (owner.module === "public") {
      for (const statement of source.statements) {
        if (
          !typescript.isExportDeclaration(statement) ||
          !statement.exportClause ||
          !typescript.isNamedExports(statement.exportClause)
        ) {
          violation(
            file,
            "exports.public",
            "public entrypoints contain only explicit named re-exports",
            statement,
            source,
          );
        }
      }
    }
    if (boundaries && owner.module && !Object.hasOwn(boundaries, owner.module))
      violation(
        file,
        "ownership.module",
        `module '${owner.module}' has no declared responsibility`,
      );
    for (const dependency of dependencies) {
      const target = location(dependency);
      if (!target) continue;
      if (owner.package !== target.package) {
        if (!packageDependencies[owner.package]?.has(target.package))
          violation(
            file,
            "direction.package",
            `forbidden package direction ${owner.package} -> ${target.package}: ${dependency}`,
          );
      } else if (owner.module && target.module && owner.module !== target.module) {
        if (!boundaries?.[owner.module]?.includes(target.module))
          violation(
            file,
            "direction.module",
            `forbidden responsibility direction ${owner.module} -> ${target.module}: ${dependency}`,
          );
      }
    }
  }

  const visit = (node) => {
    if (owner && !test) moduleImportPolicy.inspect(node, sourceContext, report);
    inspectDeclarationContracts(node, checker, sourceContext, report);
    if (owner && !test) {
      inspectVocabulary(node, publicImports, report);
      inspectRuntimeEffects(node, owner, report);
      declarationOwnership.inspect(node, sourceContext, report);
    }
    typescript.forEachChild(node, visit);
  };
  visit(source);
}

// Node tooling shares naming ownership, but does not belong to the portable runtime graph.
const toolingExtensions = sourceExtensions.flatMap((extension) => [
  extension,
  extension.replace("ts", "js"),
]);
for (const path of globSync(`tooling/**/*.{${toolingExtensions.join(",")}}`, {
  exclude: ["tooling/test/**"],
})) {
  const file = path.split(sep).join("/");
  const source = typescript.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    typescript.ScriptTarget.Latest,
    true,
  );
  const visit = (node) => {
    const abbreviated = abbreviatedDeclaration(node, publicImports);
    if (abbreviated) violation(file, "vocabulary.current", abbreviated, node, source);
    typescript.forEachChild(node, visit);
  };
  visit(source);
}

if (failures.length) {
  console.error(
    `[check-layers] ${failures.length} architecture violation(s):\n${failures.map((value) => "  " + value).join("\n")}`,
  );
  process.exit(1);
}
console.log(
  "[check-layers] OK: package directions, responsibility boundaries and source contracts hold.",
);
