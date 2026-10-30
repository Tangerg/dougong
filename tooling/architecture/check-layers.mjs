#!/usr/bin/env node

import { readFileSync } from "node:fs";
import ts from "typescript";
import { analyzeDependencies } from "./analyze-dependencies.mjs";
import { architectureRules } from "./rules.mjs";
import { retiredVocabulary } from "./vocabulary.mjs";

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
  platform: {
    public: ["artifacts", "loaders", "admission", "catalog", "activation", "errors"],
    errors: [],
    artifacts: ["errors"],
    loaders: ["artifacts", "errors"],
    admission: ["artifacts", "errors"],
    catalog: ["artifacts", "errors"],
    activation: ["artifacts", "admission", "loaders", "catalog", "errors"],
    inspection: ["artifacts", "catalog", "errors"],
  },
};

const retired = new Set(retiredVocabulary);
const factories = new Set(["service", "event", "extensionPoint"]);
const definitions = new Map();
const failures = [];
const graph = (await analyzeDependencies()).obj();

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
  if (!file.endsWith(".ts")) continue;
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const owner = location(file);
  const test = /\/test\//.test(file);
  const typedAssertions = file.endsWith("/public-api.types.ts");
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
          !ts.isExportDeclaration(statement) ||
          !statement.exportClause ||
          !ts.isNamedExports(statement.exportClause)
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

  const localFactories = new Set();
  const namespaces = new Set();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const specifier = statement.moduleSpecifier.text;
    if (owner && owner.package !== "examples") {
      if (specifier.startsWith("node:"))
        violation(
          file,
          "runtime.portable",
          "runtime libraries cannot import Node built-ins",
          statement,
          source,
        );
      if (
        (specifier !== "dougong/advanced" &&
          /^(?:dougong|@dougongjs\/(?:reactive|platform))\//.test(specifier)) ||
        /^\.\.\/\.\.\/(?:dougong|reactive|platform)\//.test(specifier)
      )
        violation(
          file,
          "exports.public",
          "package internals cannot be deep-imported",
          statement,
          source,
        );
      if (owner.package === "reactive" && !specifier.startsWith("."))
        violation(
          file,
          "reactive.independent",
          "reactive must have zero external imports",
          statement,
          source,
        );
    }
    if (specifier !== "dougong" && !specifier.endsWith("/contracts")) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements)
        if (factories.has(element.propertyName?.text ?? element.name.text))
          localFactories.add(element.name.text);
    }
  }

  const visit = (node) => {
    if (owner && !test && (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))) {
      const specifier = node.moduleSpecifier;
      if (
        specifier &&
        ts.isStringLiteral(specifier) &&
        specifier.text.startsWith(".") &&
        !/\.(?:js|mjs|cjs|json)$/.test(specifier.text)
      ) {
        violation(
          file,
          "modules.esm",
          "relative source imports require explicit runtime extensions for NodeNext consumers",
          node,
          source,
        );
      }
    }
    if (node.kind === ts.SyntaxKind.AnyKeyword)
      violation(file, "types.precise", "explicit any loses contract information", node, source);
    if (ts.isInterfaceDeclaration(node) && /(?:Port|Control)$/.test(node.name.text)) {
      for (const member of node.members)
        if (ts.isMethodSignature(member))
          violation(
            file,
            "callbacks.readonly",
            "Port and Control callbacks must be readonly function properties",
            member,
            source,
          );
    }
    if (test && !typedAssertions && ts.isIdentifier(node) && node.text === "expectTypeOf")
      violation(
        file,
        "tests.types",
        "compile-only assertions belong in public-api.types.ts",
        node,
        source,
      );
    if (owner && !test) {
      if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && retired.has(node.text))
        violation(file, "vocabulary.current", `retired vocabulary '${node.text}'`, node, source);
      if (
        owner.package !== "examples" &&
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
      ) {
        const expression = node.expression;
        if (ts.isIdentifier(expression.expression)) {
          const base = expression.expression.text;
          if (base === "console")
            violation(
              file,
              "logging.port",
              "library logging must use the Logger port",
              node,
              source,
            );
          if (
            ((base === "Date" || base === "performance") && expression.name.text === "now") ||
            (base === "Math" && expression.name.text === "random")
          )
            violation(
              file,
              "policy.explicit",
              "library policy cannot read ambient clocks or entropy",
              node,
              source,
            );
        }
      }
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "Lifetime" &&
        owner.module !== "lifetime" &&
        owner.module !== "execution"
      )
        violation(
          file,
          "lifetime.owner",
          "Lifetime roots belong to execution or an existing Lifetime",
          node,
          source,
        );
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        const factory =
          (ts.isIdentifier(expression) && localFactories.has(expression.text)) ||
          (ts.isPropertyAccessExpression(expression) &&
            ts.isIdentifier(expression.expression) &&
            namespaces.has(expression.expression.text) &&
            factories.has(expression.name.text));
        const id = node.arguments[0];
        if (factory && id && ts.isStringLiteralLike(id)) {
          const previous = definitions.get(id.text);
          if (previous)
            violation(
              file,
              "contracts.owner",
              `fixed Contract ID '${id.text}' already belongs to ${previous}`,
              node,
              source,
            );
          else definitions.set(id.text, file);
        }
      }
    }
    ts.forEachChild(node, visit);
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
