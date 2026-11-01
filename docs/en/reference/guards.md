# Mechanical guards

`pnpm check` runs generated-source verification, source and consumer types, lint, formatting, behavioral tests with per-package coverage, unused-code analysis, circular dependency analysis, responsibility checks, production builds, declaration API verification and documentation builds.

## Architecture rules

| Rule | Meaning |
| --- | --- |
| `ownership.package` | Each source package declares its responsibility |
| `ownership.module` | Production source belongs to declared responsibility directories and cannot depend on workspace tests or tooling |
| `direction.package` | Package imports follow declared directions |
| `direction.module` | Lower responsibilities do not import higher ones |
| `types.suppressions` | Silent type-check suppression is forbidden |
| `types.precise` | Explicit any is forbidden |
| `callbacks.readonly` | Port and Control callbacks are readonly function properties |
| `tests.types` | Compile-only assertions belong to public-api.types.ts |
| `runtime.portable` | Runtime libraries cannot depend on Node built-ins |
| `exports.public` | Cross-package imports use formal public entrypoints |
| `modules.esm` | Relative source imports carry runtime extensions so emitted declarations support NodeNext |
| `reactive.independent` | Reactive has zero external dependencies |
| `vocabulary.current` | Retired vocabulary cannot re-enter implementation |
| `logging.port` | Library logging uses the Logger port |
| `policy.explicit` | Library policy does not read ambient clocks or entropy |
| `lifetime.owner` | Lifetime roots belong to execution or an existing tree |
| `contracts.owner` | Fixed Contract IDs have one defining owner |

## Coverage floors

| Package | Statements | Branches | Functions | Lines |
| --- | --- | --- | --- | --- |
| dougong | 93 | 86 | 96 | 96 |
| platform | 97 | 92 | 100 | 99 |
| reactive | 96 | 89 | 100 | 99 |

Behavioral tests cover atomic publication, planning authority, rollback and quarantine, lifetime obligations, cancellation, cross-copy signals and isolated packed consumers. Guard mutation tests prove prohibited dependency directions fail. API guards inspect emitted declarations including type-only exports, require both languages to document exports and error codes, and validate navigation against real Markdown pages. Generated protocol files have one owner under `tooling/internal`; edit that source and regenerate.

The architecture guard resolves Contract factory symbols, including named aliases and namespace imports. A fixed ID carried by a typed constant or a readonly property is checked against the same declarations. Package boundaries also cover re-exports, literal dynamic imports and import types. API inspection and tarball validation follow each package’s declared `exports`; every public entrypoint, including `dougong/advanced`, must ship its JavaScript and declaration targets.

The expected public API lives in `tooling/architecture/public-api.json`. Source checks, emitted declarations and all four ESM entrypoints use the same budget.

For a release, the full gate runs on the requested versions. The packed consumer and the release use the same archives: the consumer records their hashes only after the isolated application passes. After the remaining checks finish, release verifies those hashes, the source manifests, the fetched Git commit and the remote tag before the first upload. The uploader rechecks the remote branch and tag before each upload. Git records the release only if the remote refs still match the preflight. Existing and new registry versions must match the verified file names and contents before Git records the release.

Each published manifest lists the literal files or directories to ship. Packing must preserve those files, including additional assets outside `dist/`, and cannot introduce other files or metadata. Workspace dependency ranges are resolved to the versions under test; package-manager authoring data and packaging hooks need not ship. The ESM build derives external dependencies and subpaths from each package’s manifest. The declaration check uses TypeScript’s module namespace to distinguish a constructor from a type-only re-export of the same class.
