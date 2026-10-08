# Mechanical guards

Dougong makes one architectural claim that can be checked: **a constraint that can be decided mechanically must be handed to a tool.** A rule that lives only in prose decays into a suggestion within months. A rule in the gate does not.

This page lists every check `pnpm check` actually runs, and the invariant each one protects.

```sh
pnpm check
```

Eleven steps in order, aborting on the first failure:

| # | Step | Protects |
| --- | --- | --- |
| 1 | `check:generated` | Generated callback and runtime protocols match their authoritative sources |
| 2 | `typecheck` | Five tsconfig projects plus the test project, all `--noEmit` |
| 3 | `lint` | oxlint, `--deny-warnings` |
| 4 | `format:check` | prettier |
| 5 | `test` | Behavioural semantics and the coverage floors |
| 6 | `knip` | Unused exports and dependencies |
| 7 | `check:circular` | Dependency cycles |
| 8 | `check:layers` | Import direction, module layering, architecture invariants, vocabulary |
| 9 | `build` | Dist and declaration files for the four published packages plus examples |
| 10 | `check:api` | Built-declaration type contracts, public surface, retired vocabulary, documentation coverage |
| 11 | `docs:check` | Documentation site build and dead links |

Step 9 must precede step 10: the published declaration tree is **the final artifact of the complete type surface**. Source cannot show what an `export *` expands to. `dist/index.d.ts` is the entry point of that tree.

## `check:generated`

`scripts/generate-internal.mjs --check` verifies Core and reactive’s `sync-result.ts` and `disposal-runtime.ts` against their corresponding sources under `scripts/internal/`. Synchronous callbacks, Promise requirements and disposal Symbol resolution each have one editable source. Matching each other is insufficient: both projections must match their source. `pnpm generate:internal` regenerates the projections; package builds run the same generator before bundling.

## `check:layers`

`scripts/check-layers.mjs`. Four families of check. It shares `scripts/analyze-dependencies.mjs` with the circular-dependency guard: scan scope, TypeScript resolution configuration and artifact exclusions have one configuration source, while the guards read different projections of the madge analysis. Analysis errors or any unresolved import stop verification; missing edges cannot be interpreted as an absence of violations.

### 1 · Import direction

Package level: core and reactive never import each other; platform depends only on core; the facade may only re-export; examples is the outermost consumer and no published package may depend on it in reverse.

Module level: every module of `@dougongjs/core` and `@dougongjs/platform` declares a rank in a table, and may import only modules of strictly lower rank.

::: tip The rank table is exhaustive, and checked in both directions
A new module with no rank fails — somebody has to decide which layer it sits in. A rank with no corresponding source file also fails, so renaming a file and forgetting the table cannot pass silently.
:::

### 2 · Source-text invariants

Constraints the type system cannot express but source text can decide. Two kinds.

**Prohibitions** — things that must not appear:

| Rule | Reason |
| --- | --- |
| No `node:` built-in imports | The kernel stays independent of its runtime |
| No `Date.now` / `performance.now` / `Math.random` | Hidden clocks and entropy make behaviour irreproducible |
| No direct `console` calls | Must go through the Logger port |
| No deep imports into package internals | Entry points only |
| No explicit `any` in any TypeScript AST | Source, tests and tooling all preserve the checking boundary with a precise type, `unknown` or `never` |
| No `@ts-ignore` / `@ts-nocheck` | Silent suppression makes later fixes unchecked too; repair the actual type error |
| `@ts-expect-error` appears only in `public-api.types.ts` | An expected error is a compile-time contract and does not belong in source or runtime tests |
| `*Port` / `*Control` collaborator protocols use readonly function properties only | Bivariant method parameters let a narrow internal implementation cross the type boundary silently |
| `@dougongjs/reactive` has zero external imports | It is an independent foundation |
| Resource implementations do not use `[Symbol.dispose]` / `[Symbol.asyncDispose]` directly | Foundation protocol modules must select stable keys instead of degrading a missing symbol into an `"undefined"` property |
| The facade contains re-exports only | Logic there is a second execution path |
| Lifetime diagnostic module declares read-only schemas only | Read phase and membership from the real Lifetime without a second tree, state machine or counters |
| InstanceCoordinator cannot re-read external Contract identities | Lifetime captures inert identity before granting authority, so reflection cannot cross disposal |
| Installation diagnostics cannot reach through Lifetime's execution binding for a view | Instance retains the same read-only view for terminal reads during disposal |
| Event listener registrations cannot store a publication phase | EventHub membership is the sole visibility owner |
| Installation facades cannot keep lifecycle or authority state | InstallationRecord is the sole owner |
| RegistrationRecord cannot keep a mutable Manifest mirror | Manifest derives from the same Artifact; terminal data is immutable |
| Group facades cannot keep configuration or structural phases | Read GroupConfigurationSession and GroupNode |
| ContributionStore cannot store or assign a second contribution value | ContributionRecord owns the value; Store owns publication |
| `HostImpl` must not be exported | `Host` is an interface; `createHost()` is the only constructor |
| Only `InstanceCoordinator` and `Lifetime` itself may construct a Lifetime | Anywhere else produces a resource tree nobody disposes |

**Requirements (inverted rules)** — things that **must** appear, because their absence means somebody started a second path:

| Rule | The second path it prevents |
| --- | --- |
| Host command serialization must use Core `SerialQueue` | A hand-written queue reintroduces "one failure poisons later commands" |
| Platform command serialization must use the same `SerialQueue` | The same state machine copied across packages |
| Platform diagnostics must compile to Core `SnapshotPublisher` | A duplicated observation protocol |
| Contribution observation must compose the same `SnapshotPublisher` | Likewise |
| Platform load cancellation must reuse Core `isCancellationReason` | Two cancellation classifications |
| External Error recognition in Core and Platform must reuse Core `isError` | Repeated prototype checks can replace the original rejection |
| Platform terminal failures must reuse Core `RecordedFailure` | Two terminal diagnostic recording protocols |
| Declaration boundaries must use `normalizePlainRecord` without restoring the former assertion API | Validating an object but still letting its ordinary property reads select fields |
| Service lookup consumes a normalized requirement without rereading the original wrapper | Optionality and the actual Service identity diverging |
| Async result boundaries capture then once without a check followed by another read | Observing a different asynchronous branch and missing the original rejection |
| Observation cannot reread runner.result | A different completion result detaching an unfinished Task |
| Platform declaration capture must reuse Core `normalizePlainRecord` | Two plain-data-record capture and validation semantics |
| Host must delegate declarations and handle authority to `InstallationRegistry` | Host becoming a god object again |
| Platform structural coordination must delegate activation to `Activator` | A second dependency-activation path |
| `Activator` must trust `CandidateGraph`'s cycle invariant | A second — and unreachable — graph implementation |
| ChangeSet drafts must route empty commits through their authority port | Short-circuiting lets a stale Group or Platform draft commit |
| Empty Group ChangeSets must cross the serialized boundary | Likewise |
| Empty Platform ChangeSets must cross the serialized command boundary | Likewise |
| Platform disposal must be a terminal `SerialQueue` command | A tail observer misses queued commands |
| Platform disposal must reuse Core `asyncDisposeSymbol` | A third runtime Symbol resolver |
| Group ownership must use `GroupNode` identity | Encoding ownership in a groupId prefix is an implicit relationship |

Inverted rules are the least common and the most important kind here. An ordinary gate says "do not write X". An inverted rule says "**you must** write X". The first prevents decay; the second prevents forking.

### 3 · Retired vocabulary (source)

`scripts/vocabulary.mjs` is the single source of truth, listing every identifier the vocabulary rebuild retired.

The check walks the **TypeScript AST** and matches only identifiers and string literals, so prose and concept labels are never false positives:

```text
extension-point          a concept label in prose     -> allowed
PluginHandle             a type identifier            -> fails
"PLUGIN_DEPENDENCY_..."  a retired error-code literal -> fails
```

### 4 · Fixed Contract ID uniqueness

The whole workspace is scanned for `service("...")` / `extensionPoint("...")` / `event("...")`. Declaring the same literal ID twice fails, and the message points at the first declaration.

::: warning It covers literals only
A dynamic Contract family such as `` service<T>(`workspaces/${id}/store`) `` is **deliberately skipped** — the uniqueness of a runtime ID cannot be decided statically. The gate claims only what it can prove.

Recognising a call requires tracing the factory to its import, so both `import { service as svc }` aliases and `import * as dougong` namespaces are handled.
:::

## `check:circular`

`scripts/check-circular.mjs`, madge, with an **empty allowlist**.

It reads cycles through the shared analysis boundary, without recovering output from a failed CLI process. `scripts/test/dependency-guards.test.mjs` runs the real guards against temporary source copies, verifying that unresolved imports cannot pass while retaining coverage for valid graphs, actual cycles and upward dependencies.

Every package ships as a library, and a value-level cycle between two modules of `@dougongjs/core` surfaces as a **partially-initialised binding in a consumer's bundler**, not as a failure in our tests. That is why this is stricter here than it would be in an application.

## `check:api`

First, `tsconfig.dist.json` replays the public type contracts against the built package entries. Then `scripts/check-api-surface.mjs` reads all four `dist/index.d.ts` files and resolves exported symbols through the TypeScript checker — not text matching, so what a consumer finally sees after `export *` expansion is what gets checked.

Four independent assertions per package:

1. **The exported identifiers equal the allowlist exactly**, values and types listed separately. A new export is a deliberate decision, never a side effect of an `export *`.
2. **No retired identifier returns to the public surface.** The banlist holds whole tokens rather than patterns, so valid names are unaffected:

   ```text
   Plugin  PluginContext  InstanceMeta  definePlugin   -> legal
   PluginHandle  PluginDefinition  ExtensionView       -> retired
   ```
3. **Every public export appears in both the Chinese and English documentation** for its package. Updating the allowlist cannot leave a supported API unexplained.
4. **Built declaration files contain no `any`**. The source gate cannot see types inferred by declaration emit, so this step scans every published `.d.ts` and prevents type information from disappearing at the package boundary.

The facade's surface is **computed rather than restated**: it must equal exactly core plus platform plus the reactive names it forwards, and one name too many or too few fails.

`scripts/runtime-baseline.mjs` is the single source of truth for runtime support: the workspace root and all five workspace packages must share its `engines`, the root and four published packages must share its `browserslist`, and all five Vite builds must use its derived target. A package cannot advertise one runtime range while emitting syntax that needs another.

Further checks span source and documentation:

- **Error codes** are derived from source. The two reference tables must list exactly that set, and no other page may invent a code no source throws.
- **Documentation code fragments** may not use retired identifiers. Only fenced blocks with a code language tag and inline `` `code` `` spans are extracted, so prose is unaffected.

Documentation navigation is derived from the file tree as well: every guide, reference and examples page in each language must appear in both its sidebar and homepage, and neither navigation may retain a deleted page. Adding a page can no longer update only one hand-maintained list.

## Guards on the test side

### Compile-time contracts

Each package's `public-api.types.ts` uses `expectTypeOf` and TypeScript expected-error directives to protect variance, generic inference and structural protocols, and deliberately sits outside Vitest's runtime `*.test.ts` pattern. The architecture gate prevents either kind of compile-time assertion from drifting back into runtime tests. `pnpm typecheck` first evaluates the source entries through workspace paths; after the build, `check:api` uses `tsconfig.dist.json` to redirect the same imports to the final `dist/index.d.ts`, catching consumer-visible changes caused by private-field folding or declaration generation. JavaScript emission erases these assertions; `pnpm test` alone cannot prove the contracts and does not present compile-time assertions as runtime cases.

### Runtime shape

`packages/core/test/api-surface.test.ts` asserts exact `Object.keys()` results: which keys a Context exposes, whether handles are frozen, whether internal orchestration methods leak. `check:api` guards built-declaration type relationships, exported vocabulary and `any`, while runtime tests guard actual object shape. They are complementary, because after type erasure `Object.keys` is what a consumer can actually see.

### Release query and artifact boundaries

The release command parses input only through `node:util`'s `parseArgs`, requires exactly one version argument and at most one occurrence of each option, and rejects unknown options and missing or blank OTP values. The workspace's existing `semver` library owns version syntax instead of a handwritten regular expression; input must equal the parsed version exactly. Invalid or ambiguous input is rejected before any external command.

Each package's `package.json` owns its publication identity and dependency declarations. The release script declares only directories and publication order, captures package names before preflight, and rejects missing or duplicate identities. Queries, downloads, upload confirmation and internal dependency membership use those captured names. Each tarball's name and version must match the release; its dependency set and external dependency ranges must match the original declarations, with internal dependencies projected only as this release's exact version. Missing, additional or changed dependencies are rejected; a second hardcoded package name or a version substring cannot prove artifact correctness.

Preflight and upload confirmation in `scripts/release.mjs` share `registryHasVersion`. The npm registry owns publication facts; a failed query cannot create a missing-version fact. Successful output must return exactly the requested version, and only a structured `E404` means absence. Network, permission, process-start and response-format failures stop immediately; upload polling retries only explicit `E404` responses.

When resuming a partial release, npm also owns the contents of an already published version. A local candidate may skip upload only if the complete extracted file set and the bytes of every file match. Comparing entry points alone cannot prove this: declarations referenced by those entries are also public contracts. Missing, additional or different files require a new version; archive metadata is excluded from the comparison.

Version changes are local staging owned by the release process. Before the first write, it captures the original bytes of all four `package.json` files and registers exit and signal handlers; changes derive from that snapshot. Until the release-recording stage, failure, interruption, declined publication and dry runs restore those exact bytes rather than reserializing JSON. A failed restoration must not prevent attempts for the remaining files, and must name the failed path without claiming success. Only after every package is confirmed published does the process release rollback authority and record the Git commit and tag.

`scripts/test/release.test.mjs` runs the actual release CLI in a temporary workspace with an executable search path containing only test commands, verifying strict version and option parsing, that declarations supply package identities, that missing or duplicate identities are rejected, and that unknown state cannot pass preflight. `scripts/test/release-artifacts.test.mjs` uses isolated commands and real temporary archives to check package identity, complete dependency declarations and exact internal dependency versions, as well as complete content equality, missing and additional files, and changes to declarations, documentation and binary contents when resuming a partial release. `scripts/test/release-manifests.test.mjs` injects file-read, partial-write and restoration failures in an isolated CLI process to check complete rollback and failure reporting; dry runs also verify exact byte restoration. These cases run under `pnpm test` without accessing the registry, publishing packages or changing real Git state.

### Coverage floors

`vitest.config.ts` sets per-package thresholds pinned to the measured floors, with at most one point of slack:

| Package | statements | branches | functions | lines |
| --- | --- | --- | --- | --- |
| core | 93 | 86 | 96 | 96 |
| platform | 97 | 92 | 100 | 99 |
| reactive | 96 | 89 | 100 | 99 |

A package cannot hide its own regression behind stronger coverage elsewhere in the workspace. Keeping the numbers tight is deliberate: slack is permission to quietly delete tests.

::: tip These are floors, not targets
Most of what remains uncovered is defence-in-depth behind an earlier check: a
`GroupNode.assertAttached()` that the `GroupCoordinator` has already refused, a
self-dependency `SERVICE_CYCLE` that `definePlugin` rejects first. Reaching those
lines means bypassing the public API, so pushing the numbers higher would buy
assertions about unreachable states rather than protection of behaviour.
:::

`check:api` derives this table from `vitest.config.ts` and verifies both language versions, so raising a floor without updating the documentation cannot pass.

## How to add a guard

1. **Write the gate first, run it against current code, and watch it fail.** A rule written to match a finished result is a snapshot, not a test.
2. Change the code until it passes.
3. **Reverse-verify**: remove the protected behaviour, confirm the gate turns red, then restore it.

Step 3 is mandatory for every important invariant in this repository — the [working rules](https://github.com/Tangerg/dougong/blob/main/AGENTS.md) require that "for important regressions, verify that the test fails when the protected behavior is removed".

## Related

- [Architecture](./architecture.md) — the layering and design reasoning these constraints protect
- [Core API specification](./core-api.md) — the public semantics being guarded
- [Error codes](./errors.md) — the table derived from source and cross-checked by the gate
