import typescript from "typescript";

// Use exact retired tokens so valid names sharing a substring are not rejected.
export const retiredVocabulary = Object.freeze([
  "ErrorSummary",
  "ObservationLifetime",
  "ContractRegistryDraft",
  "Application",
  "ApplicationDiagnostics",
  "ApplicationImpl",
  "ApplicationRuntime",
  "ApplicationRuntimeOptions",
  "Runtime",
  "RuntimeOptions",
  "ApplicationSnapshot",
  "ApplicationStatus",
  "CreateAppOptions",
  "RuntimeChangeOutcome",
  "createApp",
  "GroupCoordinatorHost",
  "LifetimeHost",
  "PlatformChangeHost",
  "PluginChangeHost",
  "Extension",
  "ExtensionLeaseKind",
  "ExtensionRegistry",
  "ExtensionRequirementView",
  "ExtensionStore",
  "ExtensionView",
  "GroupHandleControl",
  "GroupStatus",
  "InstallationHandle",
  "InstallationStatus",
  "PluginChangeSet",
  "PluginContainer",
  "PluginDefinition",
  "PluginGraph",
  "PluginGroup",
  "PluginGroupImpl",
  "PluginGroupState",
  "PluginHandle",
  "PluginMeta",
  "PluginSnapshot",
  "PluginUpdate",
  "discardPluginChangeSetDraft",
  "extension",
  "CreatePlatformOptions",
  "ImportPluginLoader",
  "ManagedPlugin",
  "ManagedPluginSnapshot",
  "ManagedPluginStatus",
  "MemoryPluginLoader",
  "PermissionAuthorizer",
  "PluginArtifact",
  "PluginLoader",
  "PluginManifest",
  "PluginManifestInput",
  "PluginPlatform",
  "PluginPlatformSnapshot",
  "PluginPlatformStatus",
  "loadPluginDefinition",
  "PLUGIN_CYCLE",
  "PLUGIN_DEPENDENCY_INACTIVE",
  "PLUGIN_DEPENDENCY_INCOMPATIBLE",
  "PLUGIN_DEPENDENCY_MISSING",
  "PLUGIN_DUPLICATE",
]);

const abbreviations = new Map([
  ["arg", "argument"],
  ["args", "arguments"],
  ["cb", "callback"],
  ["cfg", "configuration"],
  ["config", "configuration"],
  ["ctx", "context"],
  ["dep", "dependency"],
  ["deps", "dependencies"],
  ["dir", "directory"],
  ["dirs", "directories"],
  ["fn", "function"],
  ["idx", "index"],
  ["impl", "implementation"],
  ["meta", "metadata"],
  ["ms", "milliseconds"],
  ["opts", "options"],
]);

function preservesExternalName(node, projectImports) {
  const imported = typescript.isImportSpecifier(node);
  if (!imported && !typescript.isExportSpecifier(node)) return false;
  if (node.propertyName && node.propertyName.text !== node.name.text) return false;
  const declaration = imported ? node.parent.parent.parent : node.parent.parent;
  const specifier = declaration.moduleSpecifier;
  if (
    !specifier ||
    !typescript.isStringLiteralLike(specifier) ||
    typescript.isExternalModuleNameRelative(specifier.text) ||
    specifier.text.startsWith("#")
  )
    return false;
  for (const projectImport of projectImports)
    if (specifier.text === projectImport || specifier.text.startsWith(`${projectImport}/`))
      return false;
  return true;
}

// Data keys and unchanged foreign names belong to their protocol or declaring package.
function projectDeclarationName(node, projectImports) {
  if (!node.name) return;
  if (preservesExternalName(node, projectImports)) return;
  if (!(
    typescript.isDeclarationStatement(node) ||
    typescript.isTypeElement(node) ||
    typescript.isClassLike(node.parent) ||
    typescript.isVariableDeclaration(node) ||
    typescript.isBindingElement(node) ||
    typescript.isParameter(node) ||
    typescript.isTypeParameterDeclaration(node) ||
    typescript.isImportSpecifier(node) ||
    typescript.isImportClause(node) ||
    typescript.isNamespaceImport(node) ||
    typescript.isExportSpecifier(node)
  ))
    return;
  const name = typescript.isComputedPropertyName(node.name) ? node.name.expression : node.name;
  if (!(
    typescript.isIdentifier(name) ||
    typescript.isPrivateIdentifier(name) ||
    typescript.isStringLiteralLike(name)
  ))
    return;
  return name.text;
}

export function abbreviatedDeclaration(node, projectImports) {
  const name = projectDeclarationName(node, projectImports);
  if (!name) return;
  for (const word of name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g) ?? []) {
    const full = abbreviations.get(word.toLowerCase());
    if (full) return `Declaration '${name}' abbreviates '${full}' as '${word}'`;
  }
}
