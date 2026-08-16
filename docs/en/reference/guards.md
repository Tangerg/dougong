# Mechanical guards

Dougong makes one architectural claim that can be checked: **a constraint that can be decided mechanically must be handed to a tool.** A rule that lives only in prose decays into a suggestion within months. A rule in the gate does not.

This page lists every check `pnpm check` actually runs, and the invariant each one protects.

```sh
pnpm check
```

Ten steps in order, aborting on the first failure:

| # | Step | Protects |
| --- | --- | --- |
| 1 | `typecheck` | Five tsconfig projects plus the test project, all `--noEmit` |
| 2 | `lint` | oxlint, `--deny-warnings` |
| 3 | `format:check` | prettier |
| 4 | `test` | Behavioural semantics and the coverage floors |
| 5 | `knip` | Unused exports and dependencies |
| 6 | `check:circular` | Dependency cycles |
| 7 | `check:layers` | Import direction, module layering, architecture invariants, vocabulary |
| 8 | `build` | The dist and declaration files of all four packages |
| 9 | `check:api` | The public declaration surface, retired vocabulary, documentation coverage |
| 10 | `docs:check` | Documentation site build and dead links |

Step 8 must precede step 9: `dist/index.d.ts` is **the only place the complete type surface exists as an artifact**. Source cannot show what an `export *` expands to.

## `check:layers`

`scripts/check-layers.mjs`. Four families of check.

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
| No deep imports into another package's internals | Entry points only |
| No explicit `any` in the TypeScript AST | Preserve the checking boundary with a precise type, `unknown` or `never` instead of discarding type information |
| `@dougongjs/reactive` has zero external imports | It is an independent foundation |
| Resource implementations do not use `[Symbol.dispose]` / `[Symbol.asyncDispose]` directly | Foundation protocol modules must select stable keys instead of degrading a missing symbol into an `"undefined"` property |
| The facade contains re-exports only | Logic there is a second execution path |
| `HostImpl` must not be exported | `Host` is an interface; `createHost()` is the only constructor |
| Only `Runtime` and `Lifetime` itself may construct a Lifetime | Anywhere else produces a resource tree nobody disposes |

**Requirements (inverted rules)** — things that **must** appear, because their absence means somebody started a second path:

| Rule | The second path it prevents |
| --- | --- |
| Host command serialization must use Core `SerialQueue` | A hand-written queue reintroduces "one failure poisons later commands" |
| Platform command serialization must use the same `SerialQueue` | The same state machine copied across packages |
| Platform diagnostics must compile to Core `SnapshotPublisher` | A duplicated observation protocol |
| Contribution observation must compose the same `SnapshotPublisher` | Likewise |
| Platform load cancellation must reuse Core `isCancellationReason` | Two cancellation classifications |
| Platform declaration validation must reuse Core `assertPlainRecord` | Two prototype-chain validators |
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

Every package ships as a library, and a value-level cycle between two modules of `@dougongjs/core` surfaces as a **partially-initialised binding in a consumer's bundler**, not as a failure in our tests. That is why this is stricter here than it would be in an application.

## `check:api`

`scripts/check-api-surface.mjs`. It reads the **built** `dist/index.d.ts` of all four packages and resolves exported symbols through the TypeScript checker — not text matching, so what a consumer finally sees after `export *` expansion is what gets checked.

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

The four published packages must also match the workspace runtime baseline exactly in `engines` and `browserslist`; packages cannot advertise contradictory support ranges.

Further checks span source and documentation:

- **Error codes** are derived from source. The two reference tables must list exactly that set, and no other page may invent a code no source throws.
- **Documentation code fragments** may not use retired identifiers. Only fenced blocks with a code language tag and inline `` `code` `` spans are extracted, so prose is unaffected.

Documentation navigation is derived from the file tree as well: every guide, reference and examples page in each language must appear in both its sidebar and homepage, and neither navigation may retain a deleted page. Adding a page can no longer update only one hand-maintained list.

## Guards on the test side

### Runtime shape

`packages/core/test/api-surface.test.ts` asserts exact `Object.keys()` results: which keys a Context exposes, whether handles are frozen, whether internal orchestration methods leak. `check:api` guards the type surface; this guards the runtime shape. They are complementary, because after type erasure `Object.keys` is what a consumer can actually see.

### Coverage floors

`vitest.config.ts` sets per-package thresholds pinned to the measured floors, with at most one point of slack:

| Package | statements | branches | functions | lines |
| --- | --- | --- | --- | --- |
| core | 92 | 83 | 96 | 95 |
| platform | 97 | 90 | 100 | 98 |
| reactive | 96 | 89 | 100 | 99 |

A package cannot hide its own regression behind stronger coverage elsewhere in the workspace. Keeping the numbers tight is deliberate: slack is permission to quietly delete tests.

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
