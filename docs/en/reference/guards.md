# Mechanical guards

`pnpm check` runs generated-source verification, source and consumer types, lint, formatting, behavioral tests with per-package coverage, unused-code analysis, circular dependency analysis, responsibility checks, production builds, declaration API verification, Node and browser execution of packed consumers, and documentation builds.

Before the first consumer check, run `pnpm exec playwright install` to install the browsers matching the locked Playwright version. Linux CI uses `pnpm exec playwright install --with-deps` to install their system dependencies as well. Reinstall the matching browsers after updating Playwright.

The browser consumer is built from the inspected tarballs and runs in Chromium, Firefox and WebKit, both in the default runtime environment and with native disposal symbols absent. It checks native cancellation state, stopped event propagation, subscription detachment, observation replacement, Platform activation and Host cleanup. The consumer uses the exported disposal keys without depending on a `using` compiler to install global symbols. Build targets still follow the runtime policy; execution of the current browser engines does not claim that every historical minimum browser version has been run.

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
| `runtime.portable` | Runtime libraries cannot import Node built-ins through ESM, import-equals or the global CommonJS `require` |
| `exports.public` | Cross-package imports use formal public entrypoints |
| `modules.esm` | Relative source imports carry runtime extensions so emitted declarations support NodeNext |
| `reactive.independent` | Reactive has zero external dependencies |
| `vocabulary.current` | Rejects retired vocabulary and checks project-owned declarations for abbreviated names |
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

The distribution type checks resolve package exports as a NodeNext consumer. Importing a workspace implementation into these compile-only tests fails the TypeScript project boundary.

Core built-in error protocol values are named constants in `contracts/errors.ts`. The guard resolves actual error constructor symbols and code types to check the reference tables as a catalogue projection. Import aliases, conditional expressions and derived errors still resolve to the same protocol definitions. Other pages identify error references with Markdown links to that page, such as [`HOST_BUSY`](./errors.md). The guard checks these links, framework error constructions in executable examples, and catalogue completeness. Ordinary technical terms such as `HTTP` and `HEAD`, and application-owned code fields, do not belong to the error-code domain.

`tooling/runtime-baseline.mjs` owns the runtime range. The guard checks package manifests and getting-started documentation against it; CI reads its minimum and current release-line matrix directly. Node and browsers use the same public cancellation composition, without private Node listener options.

The expected public API lives in `tooling/architecture/public-api.json`. Source checks, emitted declarations and all four ESM entrypoints use the same budget.

Release automation supports Linux and macOS. Install the repository's declared Node and pnpm versions and make the git, npm and pnpm executables directly available on PATH. Other operating systems are rejected before workspace checks. Package managers are launched directly, without a shell.

For a release, the full gate runs on the requested versions. The packed consumer and the release use the same archives: the consumer records their hashes only after the isolated application passes. After the remaining checks finish, release verifies those hashes, the source manifests, the fetched Git commit and the remote tag before the first upload. The release pins the single push destination configured for `origin`. Its main branch must match the fetched commit. Ref reads and pushes use one command-scoped remote with identical `url` and `pushurl` values, without changing persistent configuration. If `insteadOf` would rewrite the captured destination again, the release rejects it before uploading. The uploader rechecks that destination’s branch and tag before each upload and pushes the release record to the same address. Git records the release only if the remote refs still match the preflight. Existing and new registry versions must match the verified file names and contents before Git records the release.

Preflight captures the local source commit SHA before checking ahead, behind and release-recovery conditions against that immutable value. Before changing manifests, each upload and recording the release, it verifies that the checkout still points to that source. If another operation moves the branch, the release stops and preserves that operation’s commit. Checks for an earlier source cannot authorize a different source commit, and the release does not reset the branch.

Each package has one registry destination for the release. Resolution follows npm’s precedence: the package scope’s registry, the configured scope’s registry, then the default registry. A `publishConfig` entry overrides the corresponding npm setting. `publishConfig.registry` overrides only the default registry; an existing scope-specific destination still takes precedence. Authentication, version and channel checks, publishing, and tarball readback all pin the resolved destination. Configure credentials separately through npm for that registry.

Each published manifest lists the literal files or directories to ship. Packing must preserve those files, including additional assets outside `dist/`, and cannot introduce other files or metadata. Workspace dependency ranges are resolved to the versions under test; package-manager authoring data and packaging hooks need not ship. The ESM build derives external dependencies and subpaths from each package’s manifest. The declaration check uses TypeScript’s module namespace to distinguish a constructor from a type-only re-export of the same class.

Prereleases require an npm distribution tag for each package. Run `pnpm release 0.7.2-alpha.1 --tag=next --dry-run` to verify, then omit `--dry-run` to publish. The CLI tag overrides each package’s `publishConfig.tag`. Channel names start with an ASCII letter or digit and may include letters, digits, dots, underscores and hyphens. SemVer ranges are reserved. Resume a partial upload with the same tag. For an unfinished release, the verified archives and each explicitly requested npm channel must match before Git records the release. Once the remote Git tag exists, later channel moves are valid.

After npm accepts an upload, registry visibility queries and native asynchronous Node timer waits share one monotonic deadline. Each wait is bounded by the smaller of the polling interval and the remaining budget; neither a slow query nor a wait resets the deadline. Each query receives only the remaining budget and is forcibly terminated on timeout; slow queries cannot extend the total wait. Only an explicit E404 proves that a version is not yet visible. Authentication, network, format and query-timeout failures end observation rather than imply successful publication.
