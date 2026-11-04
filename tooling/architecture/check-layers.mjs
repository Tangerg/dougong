#!/usr/bin/env node

import { globSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { relative, sep } from "node:path";
import typescript from "typescript";
import { abortListenerPort, packageEntrypoints, publishedDirectories } from "../packages.mjs";
import { analyzeDependencies, compilerOptions } from "./analyze-dependencies.mjs";
import { architectureRules, sourceExtensions } from "./rules.mjs";
import { abbreviatedDeclaration, retiredVocabulary } from "./vocabulary.mjs";

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

const retired = new Set(retiredVocabulary);
const publicImports = new Set(
  publishedDirectories.flatMap((directory) =>
    packageEntrypoints(JSON.parse(readFileSync(`${directory}/package.json`, "utf8"))).map(
      (entry) => entry.specifier,
    ),
  ),
);
const definitions = new Map();
const failures = [];
const options = compilerOptions();
const graph = (await analyzeDependencies(options)).obj();
const program = typescript.createProgram(Object.keys(graph), options);
const checker = program.getTypeChecker();
const commonJsRequire = checker.resolveName(
  "require",
  undefined,
  typescript.SymbolFlags.Value,
  false,
);
const resolution = typescript.createModuleResolutionCache(
  process.cwd(),
  typescript.sys.useCaseSensitiveFileNames ? (file) => file : (file) => file.toLowerCase(),
  options,
);
function exportedDeclarations(file, names) {
  const source = program.getSourceFile(file);
  return new Set(
    checker
      .getExportsOfModule(checker.getSymbolAtLocation(source))
      .filter((symbol) => names.includes(symbol.name))
      .flatMap((symbol) => symbol.declarations ?? []),
  );
}
const factories = exportedDeclarations("packages/dougong/src/contracts/contracts.ts", [
  "service",
  "event",
  "extensionPoint",
]);
const lifetime = exportedDeclarations("packages/dougong/src/lifetime/lifetime.ts", ["Lifetime"]);

function moduleSpecifier(node) {
  if (typescript.isImportDeclaration(node) || typescript.isExportDeclaration(node))
    return node.moduleSpecifier;
  if (typescript.isImportTypeNode(node) && typescript.isLiteralTypeNode(node.argument))
    return node.argument.literal;
  if (typescript.isExternalModuleReference(node)) return node.expression;
  if (typescript.isCallExpression(node)) {
    const callee = node.expression;
    if (callee.kind === typescript.SyntaxKind.ImportKeyword) return node.arguments[0];
    // A local function called require does not resolve modules through Node.
    if (
      typescript.isIdentifier(callee) &&
      callee.text === "require" &&
      checker.getSymbolAtLocation(callee) === commonJsRequire
    )
      return node.arguments[0];
  }
}

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
    const literal = moduleSpecifier(node);
    if (owner && !test && literal && typescript.isStringLiteralLike(literal)) {
      const specifier = literal.text;
      if (specifier.startsWith(".") && !/\.(?:js|mjs|cjs|json)$/.test(specifier)) {
        violation(
          file,
          "modules.esm",
          "relative source imports require explicit runtime extensions for NodeNext consumers",
          node,
          source,
        );
      }
      if (owner.package !== "examples" && (isBuiltin(specifier) || specifier.startsWith("node:"))) {
        violation(
          file,
          "runtime.portable",
          "runtime libraries cannot import Node built-ins",
          node,
          source,
        );
      }
      const runtimePort =
        specifier === abortListenerPort.specifier &&
        abortListenerPort.packages.includes(owner.package);
      if (owner.package === "reactive" && !specifier.startsWith(".") && !runtimePort) {
        violation(
          file,
          "reactive.independent",
          "reactive must have zero external imports",
          node,
          source,
        );
      }
      const target = typescript.resolveModuleName(
        specifier,
        source.fileName,
        options,
        typescript.sys,
        resolution,
      ).resolvedModule;
      if (target) {
        const targetFile = relative(process.cwd(), target.resolvedFileName).split(sep).join("/");
        if (
          /^(?:packages\/[^/]+|examples)\/src\//.test(file) &&
          (runtimePort
            ? targetFile !== `packages/${owner.package}/${abortListenerPort.targets.types.slice(2)}`
            : !/^(?:packages\/[^/]+|examples)\/src\//.test(targetFile) &&
              !targetFile.split("/").includes("node_modules"))
        )
          violation(
            file,
            "ownership.module",
            `runtime source cannot import a non-runtime workspace file: ${targetFile}`,
            node,
            source,
          );
        const targetPackage = targetFile.startsWith("examples/")
          ? "examples"
          : /^packages\/([^/]+)\//.exec(targetFile)?.[1];
        if (targetPackage && owner.package !== targetPackage && !publicImports.has(specifier)) {
          violation(
            file,
            "exports.public",
            "cross-package references must use a formal public entrypoint",
            node,
            source,
          );
        }
      }
    }
    if (node.kind === typescript.SyntaxKind.AnyKeyword)
      violation(file, "types.precise", "explicit any loses contract information", node, source);
    if (typescript.isInterfaceDeclaration(node) && /(?:Port|Control)$/.test(node.name.text)) {
      for (const member of node.members)
        if (
          typescript.isMethodSignature(member) ||
          (typescript.isPropertySignature(member) &&
            !member.modifiers?.some(
              (modifier) => modifier.kind === typescript.SyntaxKind.ReadonlyKeyword,
            ) &&
            checker.getNonNullableType(checker.getTypeAtLocation(member)).getCallSignatures()
              .length > 0)
        )
          violation(
            file,
            "callbacks.readonly",
            "Port and Control callbacks must be readonly function properties",
            member,
            source,
          );
    }
    if (test && !typedAssertions && typescript.isIdentifier(node) && node.text === "expectTypeOf")
      violation(
        file,
        "tests.types",
        "compile-only assertions belong in public-api.types.ts",
        node,
        source,
      );
    if (owner && !test) {
      const abbreviated = abbreviatedDeclaration(node, publicImports);
      if (abbreviated) violation(file, "vocabulary.current", abbreviated, node, source);
      if (
        (typescript.isIdentifier(node) || typescript.isStringLiteralLike(node)) &&
        retired.has(node.text)
      )
        violation(file, "vocabulary.current", `retired vocabulary '${node.text}'`, node, source);
      if (
        owner.package !== "examples" &&
        typescript.isCallExpression(node) &&
        typescript.isPropertyAccessExpression(node.expression)
      ) {
        const expression = node.expression;
        if (typescript.isIdentifier(expression.expression)) {
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
        typescript.isNewExpression(node) &&
        lifetime.has(checker.getResolvedSignature(node)?.declaration?.parent) &&
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
      if (typescript.isCallExpression(node)) {
        const id = node.arguments[0];
        if (id && factories.has(checker.getResolvedSignature(node)?.declaration)) {
          const type = checker.getTypeAtLocation(id);
          if (type.isStringLiteral()) {
            const previous = definitions.get(type.value);
            if (previous)
              violation(
                file,
                "contracts.owner",
                `fixed Contract ID '${type.value}' already belongs to ${previous}`,
                node,
                source,
              );
            else definitions.set(type.value, file);
          }
        }
      }
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
