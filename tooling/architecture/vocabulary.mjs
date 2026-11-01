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

// Application data and foreign member access can legitimately contain these same words.
export function abbreviatedDeclaration(node) {
  if (!node.name) return;
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
  for (const word of name.text.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g) ?? []) {
    const full = abbreviations.get(word.toLowerCase());
    if (full) return `Declaration '${name.text}' abbreviates '${full}' as '${word}'`;
  }
}
