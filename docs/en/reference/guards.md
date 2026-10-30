# Mechanical guards

`pnpm check` runs generated-source verification, source and consumer types, lint, formatting, behavioral tests with per-package coverage, unused-code analysis, circular dependency analysis, responsibility checks, production builds, declaration API verification and documentation builds.

## Architecture rules

| Rule | Meaning |
| --- | --- |
| `ownership.package` | Each source package declares its responsibility |
| `ownership.module` | Unknown responsibility directories are rejected |
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
