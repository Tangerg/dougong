import { isBuiltin } from "node:module";
import { relative, sep } from "node:path";
import typescript from "typescript";
import { abortListenerPort } from "../packages.mjs";

export class ModuleImportPolicy {
  #checker;
  #compilerOptions;
  #publicImports;
  #workspace;
  #commonJsRequire;
  #resolutionCache;

  constructor(checker, compilerOptions, publicImports, workspace) {
    this.#checker = checker;
    this.#compilerOptions = compilerOptions;
    this.#publicImports = publicImports;
    this.#workspace = workspace;
    this.#commonJsRequire = checker.resolveName(
      "require",
      undefined,
      typescript.SymbolFlags.Value,
      false,
    );
    this.#resolutionCache = typescript.createModuleResolutionCache(
      workspace,
      typescript.sys.useCaseSensitiveFileNames ? (file) => file : (file) => file.toLowerCase(),
      compilerOptions,
    );
  }

  inspect(node, { file, source, owner }, report) {
    const literal = this.#specifier(node);
    if (!literal || !typescript.isStringLiteralLike(literal)) return;
    const specifier = literal.text;
    if (specifier.startsWith(".") && !/\.(?:js|mjs|cjs|json)$/.test(specifier))
      report(
        "modules.esm",
        "relative source imports require explicit runtime extensions for NodeNext consumers",
        node,
      );
    if (owner.package !== "examples" && (isBuiltin(specifier) || specifier.startsWith("node:")))
      report("runtime.portable", "runtime libraries cannot import Node built-ins", node);
    const runtimePort =
      specifier === abortListenerPort.specifier &&
      abortListenerPort.packages.includes(owner.package);
    if (owner.package === "reactive" && !specifier.startsWith(".") && !runtimePort)
      report("reactive.independent", "reactive must have zero external imports", node);
    const target = typescript.resolveModuleName(
      specifier,
      source.fileName,
      this.#compilerOptions,
      typescript.sys,
      this.#resolutionCache,
    ).resolvedModule;
    if (!target) return;
    const targetFile = relative(this.#workspace, target.resolvedFileName).split(sep).join("/");
    if (
      /^(?:packages\/[^/]+|examples)\/src\//.test(file) &&
      (runtimePort
        ? targetFile !== `packages/${owner.package}/${abortListenerPort.targets.types.slice(2)}`
        : !/^(?:packages\/[^/]+|examples)\/src\//.test(targetFile) &&
          !targetFile.split("/").includes("node_modules"))
    )
      report(
        "ownership.module",
        `runtime source cannot import a non-runtime workspace file: ${targetFile}`,
        node,
      );
    const targetPackage = targetFile.startsWith("examples/")
      ? "examples"
      : /^packages\/([^/]+)\//.exec(targetFile)?.[1];
    if (targetPackage && owner.package !== targetPackage && !this.#publicImports.has(specifier))
      report(
        "exports.public",
        "cross-package references must use a formal public entrypoint",
        node,
      );
  }

  #specifier(node) {
    if (typescript.isImportDeclaration(node) || typescript.isExportDeclaration(node))
      return node.moduleSpecifier;
    if (typescript.isImportTypeNode(node) && typescript.isLiteralTypeNode(node.argument))
      return node.argument.literal;
    if (typescript.isExternalModuleReference(node)) return node.expression;
    if (!typescript.isCallExpression(node)) return;
    const callee = node.expression;
    if (callee.kind === typescript.SyntaxKind.ImportKeyword) return node.arguments[0];
    // A local function called require does not resolve modules through Node.
    if (
      typescript.isIdentifier(callee) &&
      callee.text === "require" &&
      this.#checker.getSymbolAtLocation(callee) === this.#commonJsRequire
    )
      return node.arguments[0];
  }
}
