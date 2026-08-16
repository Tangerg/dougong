# Dougong architecture

This document explains why Dougong is layered the way it is, and how its capabilities compose into frontend, backend and desktop plugin systems. For precise API behaviour see the [Core API specification](./core-api.md); for a progressive, user-facing introduction see [Core concepts](../guide/concepts.md).

## 1. Position

Dougong Core is a "capability composition and structured lifetime kernel", not an all-in-one framework.

The shared problem it solves is:

```text
where does a capability come from
→ which Installations depend on it
→ how do open contributions change dynamically
→ how are facts broadcast
→ who owns a resource, and when is it released
→ how do several changes commit and recover atomically
```

It deliberately solves no specific domain: HTTP, React, command palettes, music providers, filesystems, windows and agent tools are all higher-layer vocabulary.

## 2. Layering

```text
                         examples
                            │
                            ▼
                         dougong facade
                  ┌──────────┼──────────┐
                  ▼          ▼          ▼
              platform      core     reactive
                  │
                  └──────────► core

core and reactive do not depend on each other
```

### `@dougongjs/core`

Depends only on standard JavaScript and the Standard Schema type contract. It owns:

- Service / ExtensionPoint / Event Contracts
- Plugin and the frozen context
- the Service dependency graph and stable snapshots
- Lifetime, AbortSignal, tasks and resource release
- ChangeSet, incremental rebuild, rollback and fail-closed
- the Group ownership tree
- a SerialQueue shared across layers, where one failure does not poison later commands
- read-only diagnostic projections

Core keeps the same division internally: Host serializes public commands and publishes status over three peer collaborators; InstallationRegistry owns declarations and public handle authority; GroupCoordinator owns only structural Groups; Engine owns the committed plan and its commit, rollback and fail-closed transitions. Runtime, beneath Engine, owns live Instances and the Services, Events, ExtensionPoints and Lifetimes reachable from them. Platform reuses Core's serialization primitive directly rather than copying its failure-isolation state machine. Graph switching happens only in Engine and live execution happens only in Runtime — so declaration state, transaction state and active execution state each have exactly one source of truth instead of accumulating in one class.

### `@dougongjs/reactive`

A zero-dependency value layer providing:

- `signal()` — the current value
- `computed()` — pure derived computation
- `batch()` — coalesced invalidation notices
- `observe()` — synchronising the current value onto external resources through the public Lifetime protocol

Core does not import reactive. The two compose through the structural `get()/subscribe()` protocol and the Lifetime object protocol, which also lets third-party observables plug in.

Minimal protocols such as `Disposable` are declared separately in both foundation packages. They carry no state or implementation, and TypeScript makes them interoperate structurally. This is deliberate duplication of a protocol declaration, traded for zero dependencies in both directions. The single-path principle forbids duplicated state machines and execution semantics, not shared type sources between independent foundation packages.

### `@dougongjs/platform`

The external plugin delivery layer, owning:

- manifests and version constraints
- the loader and module boundary
- the permission decision port
- lazy activation and placeholder plugins
- manifest dependencies
- HMR and artifact updates
- the Platform ChangeSet

Platform compiles its results into ordinary Core `Plugin`s and one Core ChangeSet. It does not copy Engine semantics.

### `dougong`

A pure re-export convenience entry point: no logic, no state, no second path. Library authors who prefer strict layering can still depend on the individual packages.

### `@dougongjs/examples`

The outermost executable learning and application-reference package, depending only on the public `dougong` facade. Twelve chapters climb three stages: atoms (Service, ExtensionPoint/Event, Lifetime, signals), composition (config and failure, Contract families and Groups, diagnostics, Platform) and complete applications (Planet, Lynx, declarative plan, module-graph HMR).

The progression itself is under test: each chapter declares the concepts it is first to use, and the test concatenates all twelve declarations and compares them to the syllabus in `example.ts` for exact equality — a repeated concept, an inverted order or a chapter that adds nothing all fail.

Application strategies face real usage and regression tests here first; only after several applications converge on a stable boundary is one extracted into its own package. No foundation package may depend on examples in reverse; if an example needs access to an internal module, that means the public composition surface is not yet closed.

## 3. Why four capabilities

The four basic temporal semantics of capability change are genuinely different:

| Question | Atom | Key guarantee |
| --- | --- | --- |
| "Who can perform this operation for me?" | Service | one provider, stable for the Instance lifetime |
| "Which open contributions exist right now?" | ExtensionPoint | a map snapshot with dynamic add/remove |
| "What just happened?" | Event | nothing retained, concurrent broadcast |
| "How long does this group of resources live?" | Lifetime | structured cancellation and release |

Merging them produces smells:

- if an Event returns business results it becomes a command, a query and middleware at once
- if a Service swaps its object dynamically without rebuilding consumers, closures hold unpredictable references
- if an ExtensionPoint builds in key selection, ordering and override, it leaks Command/Theme/HTTP policy into Core
- if a Lifetime resolves dependencies, it becomes a hidden scope or IoC container

With the four separated, a Plugin only produces and a Host only orchestrates.

## 4. What "composition over inheritance" verifiably means

Dougong does not mistake "we avoid classes" for composition. There are four criteria.

### 4.1 Higher-level features get no kernel privileges

Official and third-party implementations must use the same public API. None of the following requires modifying Core:

- HTTP routes and middleware pipelines
- commands, keybindings, menus and command palettes
- UI slots, panels, themes, renderers
- music providers and playback strategy
- agent tools, model providers and event folding
- schedulers, background jobs, log sinks, metrics
- loaders, HMR, devtools and testing utilities

If an official catalog needed to read `ContributionStore` directly, the abstraction would not yet be closed.

### 4.2 Higher-level capabilities expand mechanically

```text
commands.register(command)
  = ctx.contribute(COMMANDS, command.id, command)

using(ctx, resource)
  = ctx.cleanup(() => dispose(resource))

observe(ctx, source, callback)
  = source.get + source.subscribe
  + ctx.lifetime + ctx.spawn + ctx.cleanup

registration.update(artifact)
  = platform.change().update(registration, artifact).commit()
```

A higher layer may add schemas, defaults, policy and domain errors, but may not bypass ownership, transactions or permissions.

### 4.3 Public shapes are isomorphic

- `Group` and `Installation`: `status / ready / remove`; Installation alone adds `update`
- resources releasable early: a uniform `dispose`
- observable values: a uniform `get / subscribe`
- Host and Group: a uniform `install / group / change`

Differences between layered APIs come from responsibility, not from arbitrary naming.

### 4.4 Explicit relationships are the precondition for composition

Composition is only easier to reason about than inheritance when boundaries are visible. Dougong never guesses a Service provider from a Group, an ancestor Context, the call stack or a global "current value", and never guesses setup order from install order. Capability selection lives in the Contract ID, dependencies live in `requires`, ownership lives in Lifetimes, and execution-time selection lives in ordinary method parameters.

That also constrains higher-level sugar: it may generate tokens, `Plugin`s or ChangeSets, but the expansion must express the relationship completely. It may not hide part of the semantics in a second scope/shadow/interceptor graph.

## 5. The Service graph and ordinary closures

Services do not use live proxies:

```text
provider A ──► consumer B ──► consumer C
```

When A is updated, Host computes the affected closure over both the old and new graph, stops in `C → B → A` order and starts in `A → B → C` order. Unaffected plugins never restart.

Host caches only the validated graph corresponding to committed execution state. `host.get()` is a constant-time map lookup on that graph; candidate graphs are built only during `start()` or ChangeSet validation, and replace the cache only after the transaction fully succeeds. An idle installation plan may temporarily lack dependencies, which preserves the "declare several Installations, then start once" workflow.

When a ChangeSet commits while the Host is active, its stop-and-rebuild window is an explicit `changing` status, not a fake active. Application-code Service reads are closed during it and only resume at `active` after a successful commit or complete rollback, so one read boundary never mixes the old graph with new Instances.

That is what makes ordinary closures safe:

```ts
setup(ctx) {
  const database = ctx.database
  return createUsers(database)
}
```

No signal, no proxy, no "has my dependency changed?" defensive logic. Stable Services are a major source of low cognitive load.

The dependency graph also yields immutable topological layers. Host prepares a whole layer concurrently and commits it in stable install order only after every setup and Service output validates; the next layer may only read already-committed predecessor Services. A setup failure in any Installation of a layer cancels the rest of that layer's setup and releases every unpublished Lifetime in it.

```text
layer 0  [database, cache, logger]  ── concurrent prepare ── commit
layer 1  [users, search]            ── concurrent prepare ── commit
layer 2  [http]                     ── prepare ───────────── commit
```

This is not "guess which plugins can run concurrently": the only basis is still the explicit Service edge. Events and ExtensionPoints form no startup dependency, and the relative order of independent setups is undefined. A plugin that needs ordering must declare a Service; it may not rely on install order or microtask timing. Stopping stays serial in reverse dependency order, because the order in which resources are revoked is observable semantics, not a mirror image of the startup throughput problem.

## 6. Why ExtensionPoints stay raw

A Core ExtensionPoint has the highest information fidelity: every contribution is retained, and real keys carry the installation prefix. It neither discards older values for the same domain key nor imposes an order.

That lets each domain choose its own policy:

```text
raw contributions
├── group by command.id + reject duplicate  → CommandCatalog
├── group by theme.id + last wins stack     → ThemeCatalog
├── sort by order + reduceRight             → MiddlewarePipeline
├── filter by slot                          → UI slot
└── score + select                          → ProviderSelector
```

If Core exposed only "the current winner", the information needed to restore the previous theme after an unload would already be gone. If Core mandated last-wins, a command system wanting to reject duplicates would need a bypass. Only by keeping the raw set can policies genuinely compose.

`ContributionView` shares the structural protocol with signals but is not a signal node. `computed()` tracks only Dougong signals, so an apparently pure computation cannot secretly subscribe to an arbitrary external store. When cross-layer synchronisation is needed, use an explicit `subscribe` or reactive `observe()`.

## 7. Lifetime is the composition foundation

Every Instance owns a root Lifetime forming a resource tree:

```text
Plugin Lifetime
├── event subscription
├── extension contribution
├── ContributionView subscription
├── background task
├── child Lifetime ("session")
│   ├── task
│   └── cleanup
└── cleanup stack
```

This is not a hook or a reactive effect; it is ownership. Children are created through the single entry point `lifetime(label)`, where the label describes why this group of resources lives together and takes no part in dependency resolution, execution lookup or identity.

Order is encoded explicitly as an object state machine: revoke public capabilities first, then cancel tasks and children, then run user cleanups. Internally nothing relies on "reversing whatever registration order happened" to obtain correct semantics.

A child Lifetime disposed early detaches from the parent's ownership set. A background task that settles naturally detaches from both the parent task set and the parent AbortSignal listeners; releasing a parent only cancels and awaits tasks still running. Both prevent a long-lived owner from accumulating completed objects proportional to its history.

The same rule covers every internal lease: listeners, contributions, ContributionViews and their subscriptions, cleanups and tasks all detach from the parent set on early termination, and terminal objects clear their owner, store, callback, payload and diagnostic-accounting references. The seven resource categories reuse one live-resource-set implementation, giving O(1) detachment, idempotent ownership release and diagnostic accounting. They still use separate sets to express publication order, release order and per-category counts — a shared mechanism, not mixed semantics.

Actively releasing a Lifetime or Task uses a module-level frozen `AbortError` as the cancellation reason, while a parent cancellation forwards the parent's reason unchanged during the active phase. What is shared is only a stateless error value, not an ambient scope; it prevents the stack automatically created by every `abort()` from turning a terminal `AbortSignal.reason` into a hidden retaining edge back to the Host. After release, the Lifetime replaces its active signal with a fresh aborted signal carrying that shared `AbortError`, so a terminal resource keeps neither the old signal's listener closures nor a parent reason that may carry application objects. An in-flight release promise belongs only to the `disposing` state and is structurally dropped on reaching `disposed`; the original failure is still observed by whoever obtained that promise.

A parent owns only what is still alive, so holding a released resource never keeps the whole Host alive. `ContributionView` uses an explicit narrow facade rather than arrow functions returned from store methods that capture lexical `this` — once the binding is cleared, the public view itself cannot become a hidden ownership edge into the store.

The same constraint applies to installation ownership: a terminal `InstallationRecord` keeps only an immutable Group ID, and a detached Group clears its parent, transaction barrier and historical failure. A historical Installation or Group therefore cannot keep a sibling Group or the Host root alive through the ownership tree or an error stack.

Terminal detachment covers error objects too. V8's `Error.stack` may carry the orchestration frames present when the error was created, so a failed Installation or Registration that has detached from its owner keeps only a `name/message/code` summary and reconstructs an error when the caller reads the failure again. Callers still awaiting a commit receive the original error. Nothing is silently dropped, and a call stack never becomes an invisible Host ownership edge.

`ContributionRegistry` likewise keeps only stores that still have a claim, view or subscription; when the last owner releases it, an empty store is removed from the registry. A failed setup that touched a never-committed ExtensionPoint ID therefore cannot make a Host accumulate empty stores proportional to its failure history.

A ContributionView subscription contains two orthogonal internal ownership edges: the Lifetime owns the subscription resource, and the ContributionStore owns the listener registration. One public `dispose()` must cut both — the first so the parent Lifetime does not accumulate terminal resources, the second so the store neither keeps notifying nor keeps an unsubscribed callback alive. That is internal atomic release of a single Disposable operation, not a second public API.

Every root Lifetime also maintains a read-only diagnostic view. It projects the real Lifetime ownership relationship node by node: the root label is the Installation ID, child labels come from `lifetime(label)`, and each node reports the resources it directly owns, categorised into cleanups, Tasks, listeners, Contributions, ContributionViews and subscriptions. Subtree totals are derived recursively rather than stored a second time in each node. The diagnostic tree stores no leaf resources and invents no pseudo-nodes from call stacks or function names. Only a real shared release boundary forms a node, so the diagnostic structure always agrees with execution semantics.

That view reuses the `get/subscribe` protocol and is separate from the Host structural snapshot: high-frequency resource churn never rebuilds the whole Installation graph, while devtools can still answer "which group of resources currently holds what". A child Lifetime detaches from its parent node as soon as it terminates; a terminal root view keeps only a childless, all-zero snapshot and keeps neither the Host nor any resource object alive.

## 8. The transaction model

Core distinguishes three transaction boundaries.

### Plugin setup

Contract kinds, listeners and Contributions all enter a transaction draft first. Contract kinds reach the Engine registry only after Service outputs and the whole Instance switch succeed; listeners and Contributions are published with the Lifetime of their topological layer. A failed setup or a rollback discards the draft and severs the draft's reference to the registry authority, so it can neither leave a ghost Contract identity behind nor let a terminal draft keep the registry alive. Public facades expose only `dispose/update`, never an internal `publish()`, so even a JavaScript Plugin cannot cross the commit point early.

### ExtensionPoint notification

Host start, stop and ChangeSet use batches. The internal map may go through stop and rebuild, but a view's public snapshot switches exactly once, at the end of the transaction.

A ChangeSet committed while the Host is active first produces a committed or rolled-back outcome; the corresponding Installations settle only after the ExtensionPoint batch has published. `ready()` is therefore a transaction barrier and never resolves before the final ExtensionPoint snapshot.

### Multi-Installation graph change

A ChangeSet builds and validates the complete candidate graph before touching committed execution state. Once inside the execution window the Host is `changing`, so `host.get()` never observes per-Instance stops and starts; it returns to active only after success or a completed rollback. Any incomplete cleanup fails closed rather than leaving a mixed state that merely "looks active".

Top-level side effects of a dynamic import, network requests and operating-system resources cannot be rolled back by an in-memory transaction. Those are the loader's or the plugin's compensation responsibility, and the documentation must not dress a framework transaction up as a distributed-transaction promise.

## 9. Why a Group is not a scope

A Group solves:

- how a set of installations shares one commit
- how they nest
- how to await a set of Installations becoming ready
- how to atomically delete a whole installation subtree

Group configuration, structural ownership, lifecycle state and facade authority each use a closed state machine. The configuration session is `open / failed / sealed`, the structural node is `attached / detached`, the lifecycle keeps the established flag and the current readiness barrier, and the public Group is `configuring / attached / revoked`.

Those state machines are composed by an internal `GroupCoordinator` instead of being scattered through the Host orchestrator. The coordinator fully owns the Group tree, facade authority and readiness; Host supplies only Installation ChangeSets, serialized commands and diagnostics publication through narrow ports. That boundary adds no public concept and grants a Group no capability-resolution power.

A nested `configure` shares one configuration session; the first failure poisons the whole draft, so an outer caller that swallows the exception still cannot continue declaring or commit. Any non-`Error` failure is classified at the boundary before entering the lifecycle, so `undefined` never means both "the failure value" and "no failure". A failed change against an established Group that rolls back completely keeps presenting the committed state; a Group that was never established can have its failed barrier replaced by a later successful change.

What a Group does not solve is "who can see which capability". Services, ExtensionPoints and Events are globally consistent within one Host.

Pushing capability scoping into Groups would introduce three new rule sets: ancestor inheritance, local shadowing, and event bubbling or isolation. Loaders, diagnostics and transactions would all then have to understand a spatial graph. That is not a natural consequence of the four capability atoms, and it is easily mistaken for security isolation.

When isolation is genuinely required, pick an explicit boundary:

| Need | Recommendation |
| --- | --- |
| Batch install/uninstall only | Group |
| A few fixed workspaces each holding a same-shaped capability | An explicit Contract family |
| Selecting workspace data per request | A Service API taking an explicit workspace ID |
| An independent capability graph | Multiple Hosts |
| Untrusted code | Worker / iframe / process / restricted realm |
| Remote capabilities | An RPC Service proxy |

That keeps "organisation" and "isolation" from leaking into each other through one vague abstraction.

A Contract family is just ordinary function composition over the existing `service()`, not a fifth Contract kind:

```ts
const workspaceStore = (workspace: string) =>
  service<Store>(`workspace/${encodeURIComponent(workspace)}/store`)

const ALPHA_STORE = workspaceStore("alpha")

const alphaStorePlugin = definePlugin({
  name: "workspace.alpha.store",
  provides: { store: ALPHA_STORE },
  setup: () => ({ store: createStore("alpha") }),
})

const alphaSearchPlugin = definePlugin({
  name: "workspace.alpha.search",
  requires: { store: ALPHA_STORE },
  setup: ctx => createSearch(ctx.store),
})
```

One interface can have many providers, but each provider belongs to a distinct explicit ID, and conflicts, absences, dependency closures and diagnostics are still handled by the same InstallationGraph. To layer configuration over one particular Service, use an explicit adapter plugin: it requires the base token, provides a new token, and constructs the wrapped value using types that Service itself understands. Core offers no untypeable general `intercept()` or proxy shadow chain.

## 10. Signals and the side-effect boundary

Signals deserve to exist, but automatic tracking enters only pure computeds:

```text
signal    the current value
computed  how a value is purely derived
observe   how a set of resources is rebuilt after a change
Lifetime  when this synchronisation ends
```

`computed()` and `batch()` both reject thenable results, so synchronous tracking and batch boundaries are never mistakenly extended past an `await`. `observe()` creates one long-lived drain task managed by the owner; notifications merely wake it, and a failed replacement is reported through the task result and stops the observation.

`observe()` lives in the reactive layer rather than in Context because:

1. it can be implemented entirely through public protocols, so Core needs no privilege
2. backends that do not use signals need not carry reactive concepts
3. the Context API budget does not inflate
4. third-party `Readable`s are structurally compatible
5. automatic tracking never controls plugin setup or resource boundaries

Effect-TS overlaps heavily with Core on DI, scope, fiber and the error execution model, so only one-way adaptation is allowed; it does not enter the base model.

## 11. Platform and the security boundary

Same-realm JavaScript can always reach the global environment. Manifest permissions express application policy; they are not a sandbox.

```text
trusted plugins       same-realm ESM, may contribute functions and UI components
semi-trusted plugins  same realm plus admission/activation permission review
untrusted plugins     Worker / iframe / separate process
cross-realm           serialized messages or an RPC Service
untrusted UI          declarative data rendered by application code
```

A Platform loader may return an application-authored RPC `Plugin`. Core then sees only ordinary Services and Lifetimes and never needs to know the transport.

Platform activation and structural change are orthogonal command flows, but their committed state must agree. The internal `Activator` exclusively owns dependency activation, `ActivationGate` permits and change-target exclusion; Platform only serializes public commands and commits structural transactions. When a ChangeSet begins execution, it first fixes which updates remain activated, then completes candidate-graph, permission and module preflight. Through Activator's one-shot barrier it closes new activation, cancels explicit targets and awaits existing permits before revalidating stable state against that same plan and committing exactly one Core ChangeSet. A failed preflight therefore has no cancellation side effect, and a concurrent activation can neither change the meaning of the current change nor create a dangling dependency in the gap between validation and commit.

## 12. Mapping to real projects

### Planet

| Need | Dougong composition |
| --- | --- |
| Player / database | Service |
| Music sources | raw ExtensionPoint contributions + a ProviderSelector |
| Track change | Event or a store Service |
| Audio connection | Lifetime + spawn + cleanup |
| Provider hot-swap | Platform activation + Core update/remove |

Changing provider contributions never restarts the player; the player subscribes to the ContributionView and updates its own selector.

### Lynx Desktop

| Need | Dougong composition |
| --- | --- |
| Commands, menus, panels, renderers | ExtensionPoint |
| Unique commands and theme override | a domain catalog Service |
| Filesystem, windows, storage | application-provided Services |
| A set of workspace plugins | Group |
| sideload / lazy / HMR | Platform |
| Live React display | a thin `useSyncExternalStore` adapter |
| Untrusted extensions | Worker/iframe + RPC Service |

Group removal handles installation ownership; a workspace ID inside domain values handles data selection. Two clear responsibilities, no implicit scope.

## 13. The dependency-direction gate

`scripts/check-layers.mjs` turns the following rules into CI failures:

- core and reactive never import each other
- platform is never depended on in reverse by core or reactive
- the facade may only re-export
- examples may only be the outermost consumer; no package may depend on it in reverse
- modules inside Core/Platform may only import strictly lower ranks
- Core/Platform sources import no Node built-ins
- source code reads no hidden clock or entropy
- diagnostics never call console directly
- a Lifetime may only be constructed by Engine and Lifetime itself
- no circular dependencies

An architectural constraint that exists only in prose degrades into a suggestion within months. Dougong hands the mechanically decidable part to tooling.

## 14. Long-term criteria

Before adding an abstraction, check every item:

1. Can it be expressed with the existing four capabilities?
2. Is it merely one domain's key/order/conflict policy?
3. Does it become a same-layer synonym of an existing API?
4. Does it need Core-private state, or is the public protocol already sufficient?
5. Does it change the lifecycle, transaction or error model?
6. Does it leak internal objects beyond the type level?
7. Does it mislabel organisation, permission or convenience as security isolation?
8. With every concrete framework and application adapter removed, does the abstraction still hold?

Dougong's goal is not "the Core with the most features" but "the smallest closed Core": few enough atoms, expressive enough composition, and no advanced capability needing to escape to a lower layer.
