import typescript from "typescript";
import { dirname, resolve } from "node:path";

const referenceTables = new Set(
  ["docs/reference/errors.md", "docs/en/reference/errors.md"].map((path) => resolve("/", path)),
);

export function constructedErrorCode(node) {
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

export function errorDocumentationFailures(documentPath, text, sourceCodes) {
  const referenceTable = referenceTables.has(resolve("/", documentPath));
  const referenced = new Set();
  const prose = text.replace(
    /(?:^|\n)(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n\1(?=\n|$)/g,
    (_block, _fence, language, source) => {
      if (/^\s*(?:[cm]?[jt]sx?|typescript|javascript)\b/i.test(language))
        constructedErrorCodes(source, referenced);
      return "\n";
    },
  );
  // A link names the error domain; capitalization alone cannot distinguish HTTP from an error code.
  for (const [, code, target] of prose.matchAll(/\[`([^`\n]+)`\]\(([^\s)]+)\)/g)) {
    if (URL.canParse(target) || target.startsWith("//")) continue;
    const referencePath = resolve("/", dirname(documentPath), target.split("#", 1)[0]);
    if (referenceTables.has(referencePath)) referenced.add(code);
  }
  const catalogued = new Set(
    referenceTable ? [...prose.matchAll(/^\|\s*`([^`\n]+)`\s*\|/gm)].map(([, code]) => code) : [],
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
