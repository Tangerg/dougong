import typescript from "typescript";
import { abbreviatedDeclaration, retiredVocabulary } from "./vocabulary.mjs";

const retired = new Set(retiredVocabulary);

export function inspectDeclarationContracts(node, checker, { test, typedAssertions }, report) {
  if (node.kind === typescript.SyntaxKind.AnyKeyword)
    report("types.precise", "explicit any loses contract information", node);
  if (typescript.isInterfaceDeclaration(node) && /(?:Port|Control)$/.test(node.name.text)) {
    for (const member of node.members)
      if (
        typescript.isMethodSignature(member) ||
        (typescript.isPropertySignature(member) &&
          !member.modifiers?.some(
            (modifier) => modifier.kind === typescript.SyntaxKind.ReadonlyKeyword,
          ) &&
          checker.getNonNullableType(checker.getTypeAtLocation(member)).getCallSignatures().length >
            0)
      )
        report(
          "callbacks.readonly",
          "Port and Control callbacks must be readonly function properties",
          member,
        );
  }
  if (test && !typedAssertions && typescript.isIdentifier(node) && node.text === "expectTypeOf")
    report("tests.types", "compile-only assertions belong in public-api.types.ts", node);
}

export function inspectVocabulary(node, publicImports, report) {
  const abbreviated = abbreviatedDeclaration(node, publicImports);
  if (abbreviated) report("vocabulary.current", abbreviated, node);
  if (
    (typescript.isIdentifier(node) || typescript.isStringLiteralLike(node)) &&
    retired.has(node.text)
  )
    report("vocabulary.current", `retired vocabulary '${node.text}'`, node);
}

export function inspectRuntimeEffects(node, owner, report) {
  if (
    owner.package === "examples" ||
    !typescript.isCallExpression(node) ||
    !typescript.isPropertyAccessExpression(node.expression)
  )
    return;
  const expression = node.expression;
  if (!typescript.isIdentifier(expression.expression)) return;
  const base = expression.expression.text;
  if (base === "console") report("logging.port", "library logging must use the Logger port", node);
  if (
    ((base === "Date" || base === "performance") && expression.name.text === "now") ||
    (base === "Math" && expression.name.text === "random")
  )
    report("policy.explicit", "library policy cannot read ambient clocks or entropy", node);
}

export class DeclarationOwnership {
  #checker;
  #contractFactories;
  #lifetimeDeclarations;
  #contractOwners = new Map();

  constructor(program) {
    this.#checker = program.getTypeChecker();
    this.#contractFactories = exportedDeclarations(
      program,
      "packages/dougong/src/contracts/contracts.ts",
      ["service", "event", "extensionPoint"],
    );
    this.#lifetimeDeclarations = exportedDeclarations(
      program,
      "packages/dougong/src/lifetime/lifetime.ts",
      ["Lifetime"],
    );
  }

  inspect(node, { file, owner }, report) {
    if (
      typescript.isNewExpression(node) &&
      this.#lifetimeDeclarations.has(
        this.#checker.getResolvedSignature(node)?.declaration?.parent,
      ) &&
      owner.module !== "lifetime" &&
      owner.module !== "execution"
    )
      report("lifetime.owner", "Lifetime roots belong to execution or an existing Lifetime", node);
    if (!typescript.isCallExpression(node)) return;
    const id = node.arguments[0];
    if (!id || !this.#contractFactories.has(this.#checker.getResolvedSignature(node)?.declaration))
      return;
    const type = this.#checker.getTypeAtLocation(id);
    if (!type.isStringLiteral()) return;
    const previous = this.#contractOwners.get(type.value);
    if (previous)
      report(
        "contracts.owner",
        `fixed Contract ID '${type.value}' already belongs to ${previous}`,
        node,
      );
    else this.#contractOwners.set(type.value, file);
  }
}

function exportedDeclarations(program, file, names) {
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file);
  return new Set(
    checker
      .getExportsOfModule(checker.getSymbolAtLocation(source))
      .filter((symbol) => names.includes(symbol.name))
      .flatMap((symbol) => symbol.declarations ?? []),
  );
}
