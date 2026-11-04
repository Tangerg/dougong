import typescript from "typescript";
import { posix } from "node:path";
import { documentationTarget } from "./markdown-document.mjs";

const referenceTables = new Set(
  ["docs/reference/errors.md", "docs/en/reference/errors.md"].map((path) =>
    posix.resolve("/", path),
  ),
);

export function sourceErrorCodes(program, modulePath, exportName) {
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(modulePath);
  const moduleSymbol = source && checker.getSymbolAtLocation(source);
  const exportedSymbol =
    moduleSymbol &&
    checker.getExportsOfModule(moduleSymbol).find(({ name }) => name === exportName);
  const errorSymbol =
    exportedSymbol &&
    (exportedSymbol.flags & typescript.SymbolFlags.Alias
      ? checker.getAliasedSymbol(exportedSymbol)
      : exportedSymbol);
  const errorClass = errorSymbol?.valueDeclaration;
  if (!errorClass || !typescript.isClassDeclaration(errorClass))
    throw new TypeError(`${modulePath} must export error class '${exportName}'`);

  const codes = new Set();
  const collect = (type) => {
    if (type.isStringLiteral()) codes.add(type.value);
    else if (type.isUnion()) for (const member of type.types) collect(member);
  };
  const isErrorType = (type) => {
    const symbol = type.getSymbol();
    if (!symbol) return false;
    if (symbol === errorSymbol) return true;
    const declaredType = checker.getDeclaredTypeOfSymbol(symbol);
    return declaredType.isClassOrInterface() && declaredType.getBaseTypes().some(isErrorType);
  };
  const visit = (node) => {
    if (typescript.isNewExpression(node)) {
      const type = checker.getTypeAtLocation(node);
      if (isErrorType(type)) {
        // A derived constructor can take a label first; its inherited code type names the error protocol.
        const code = checker.getPropertyOfType(type, "code");
        if (code) collect(checker.getTypeOfSymbolAtLocation(code, node));
      }
    } else if (
      typescript.isCallExpression(node) &&
      node.expression.kind === typescript.SyntaxKind.SuperKeyword
    ) {
      const constructor = checker.getResolvedSignature(node)?.declaration;
      if (constructor?.parent === errorClass && node.arguments[0])
        collect(checker.getTypeAtLocation(node.arguments[0]));
    }
    typescript.forEachChild(node, visit);
  };
  for (const file of program.getRootFileNames()) visit(program.getSourceFile(file));
  return codes;
}

function constructedErrorCode(node) {
  if (
    !typescript.isNewExpression(node) ||
    !typescript.isIdentifier(node.expression) ||
    !["DougongError", "PlatformError"].includes(node.expression.text)
  )
    return;
  const code = node.arguments?.[0];
  return code && typescript.isStringLiteralLike(code) ? code.text : undefined;
}

function constructedErrorCodes(source, codes) {
  const tree = typescript.createSourceFile(
    "documentation.ts",
    source,
    typescript.ScriptTarget.Latest,
    true,
    typescript.ScriptKind.TS,
  );
  const visit = (node) => {
    const code = constructedErrorCode(node);
    if (code !== undefined) codes.add(code);
    typescript.forEachChild(node, visit);
  };
  visit(tree);
}

export function errorDocumentationFailures(documentPath, document, sourceCodes) {
  const referenceTable = referenceTables.has(posix.resolve("/", documentPath));
  const referenced = new Set();
  for (const source of document.scriptBlocks()) constructedErrorCodes(source, referenced);
  // A link names the error domain; capitalization alone cannot distinguish HTTP from an error code.
  for (const { target, codes } of document.links()) {
    const referencePath = documentationTarget(documentPath, target);
    if (referenceTables.has(referencePath)) for (const code of codes) referenced.add(code);
  }
  const catalogued = new Set(
    referenceTable ? document.tableRows().flatMap((row) => row[0]?.codes ?? []) : [],
  );
  const failures = [];
  for (const code of new Set([...referenced, ...catalogued])) {
    if (!sourceCodes.has(code)) failures.push(`documents '${code}', which no source throws`);
  }
  if (referenceTable) {
    for (const code of sourceCodes) {
      if (!catalogued.has(code)) failures.push(`error code '${code}' is not documented`);
    }
  }
  return failures;
}
