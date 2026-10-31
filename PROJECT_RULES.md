# Dougong repository guidance

## Domain vocabulary

Every domain noun names one responsibility or lifecycle stage. Reading the name must be enough to
know which layer an object belongs to, who owns it, and what may be done to it —
without opening the implementation.

```text
Manifest + Reference → Artifact → Catalog           (available immutable revisions)
                            ↓ selected by
                       Registration                 (Platform selection)
                            ↓ compiles to one Plan
Plugin → Installation → Instance                    (Core declaration → identity → execution)

Host exposes commands. Its Engine alone commits declarations, bindings, and
Instances. Installation origin records the Artifact revision actually committed.
```

| Noun | Stage | Layer |
| --- | --- | --- |
| `Plugin` | A declaration. Reusable, inert, owns nothing | Core |
| `Installation` | The stable identity of one installed Plugin. Its declaration may be replaced; its identity and position may not | Core |
| `Instance` | One active execution of an Installation. Internal and replaced on restart | Core |
| `Group` | An installation-ownership subtree. Nothing else | Core |
| `Engine` | The internal authority for committed declarations, bindings, Instances, revisions and graph transitions | Core |
| `Host` | The public execution boundary: plan, apply, structured borrowing, inspection | Core |
| `Plan` | An immutable preview with in-process execution authority bound to one Host and state revision | Core |
| `Artifact` | An immutable, explicitly identified revision containing a manifest and a load reference | Platform |
| `Catalog` | The available Artifact revisions | Platform |
| `Registration` | The stable delivery identity owning the selected Artifact revision; active origin is a Core projection | Platform |
| `Platform` | The delivery boundary: declaration, authorization, loading, activation | Platform |

Three words that used to mean "host" are now distinct, and must stay distinct in
code, comments, error messages and documentation:

- **`Host`** — the Dougong execution boundary. A product may run several.
- **application code** — the code that embeds Dougong and borrows Services through `host.use()`. Never called a host.
- **runtime** — the JavaScript environment (Node, a browser, a WebView). Never called a host.
- **`*Port`** — an internal collaborator protocol (`LifetimePort`, `ChangePort`). Never called a host either.

Retired names must not return. `tooling/architecture/vocabulary.mjs` holds the banlist;
`check-layers.mjs` checks source tokens, while `check-api-surface.mjs` checks
built declarations and code-shaped Markdown, so neither an `export *` nor stale
documentation can smuggle one back in.

## Project philosophy

- Treat explainability as an architecture test. In a coherent design, names, responsibilities, dependency directions, ownership, and execution behavior agree; if the implementation is hard to explain through the public model, first assume that the model or implementation is wrong.
- Make important relationships explicit. Dependencies belong in declarations, ownership belongs in Lifetimes, capability identity belongs in Contracts, and execution-time choices belong in ordinary parameters. Do not infer them from ambient state, call stacks, installation order, ancestor lookup, or hidden globals.
- Choose the simplest model that completely expresses the requirement. Do not confuse simplicity with missing semantics: keep irreducible complexity visible instead of hiding it behind magic.
- Keep the conceptual structure as flat and orthogonal as the domain permits. Add nesting only when it represents real ownership or composition, never merely to organize implementation details.
- Keep components modular and responsibilities sharply separated. Introduce an abstraction only when it clarifies an existing responsibility or a real composition point.
- Keep APIs sparse. Every public concept must earn its place, have one precise responsibility, and compose with the existing primitives.
- Design for the reader. Prefer ordinary TypeScript, intention-revealing names, small state machines, and local reasoning over clever metaprogramming, implicit proxies, decorators, or surprising control flow.
- Never let errors disappear accidentally. Propagate, aggregate, report, or explicitly classify them as cancellation; silence them only at a deliberate boundary whose behavior is documented.
- Refuse to guess when input, ownership, capability selection, or state is ambiguous. Reject the operation with a precise error and require the caller to make the choice explicit.
- Use namespaces deliberately. Stable Contract IDs, module boundaries, and package layers should prevent collisions and communicate ownership; do not turn Context into a bag of globally mixed names.

## Dougong architecture axioms

- Composition is preferred over inheritance. Higher-level capabilities are built from Service, ExtensionPoint, Event, Lifetime, Plugin, Host, and their public protocols rather than framework base classes or privileged hooks.
- The same capability at the same abstraction layer has exactly one canonical API. Do not add aliases, parallel configuration forms, or alternate lifecycle paths. Special cases must use composition or a higher layer unless their underlying semantics are genuinely different.
- Higher layers may provide domain vocabulary and ergonomic sugar, but they must compile to Core primitives and must not duplicate registries, dependency graphs, transactions, resource ownership, observation protocols, or error semantics.
- Keep the core atoms orthogonal: Service is stable capability, ExtensionPoint is an open contribution set, Event is a transient fact, and Lifetime is structured ownership. Do not make one atom secretly perform another atom's job.
- Group expresses installation ownership only. It is not a capability scope, provider shadow tree, permission boundary, or security sandbox.
- Stable Service dependencies are declared through `requires`; Core does not use a Service Locator, ambient scope, prototype-chain injection, or live Service proxy.
- Static multi-instance capabilities use explicit Contract families. Execution-time tenant or workspace selection uses explicit Service parameters. A Host is an execution and ownership boundary, never a security sandbox. Untrusted code requires an actual isolation boundary such as a Worker with a constrained protocol, a sandboxed iframe, a process, or a Wasm runtime.
- Resource ownership is structural and terminal resources detach from their owners. A retained handle must not keep a Host, Store, callback, payload, or completed task alive without a documented reason.
- Transactions expose only committed states. Setup declarations remain staged until their commit boundary, and failed changes roll back or fail closed rather than presenting mixed execution state as healthy.
- Package and module dependencies point in one direction. `dougong` contains the actual Core; there is no second Core package or facade. `@dougongjs/reactive` is independent. `@dougongjs/platform` compiles delivery concerns into Core's public APIs. Reusable advanced primitives are exposed through `dougong/advanced`.
- Physical source directories follow logical ownership. Core responsibilities are contracts, composition, execution, lifetime, events, contributions, observation, and inspection. Platform responsibilities are artifacts, catalog, admission, loaders, and activation. Examples live under `examples/`; repository tooling lives under `tooling/`. The architecture guard enforces allowed dependencies between these responsibilities.
- Engine is the sole authority for committed declarations, bindings, active Instances, revisions, and quarantine. Installation and Group handles are read-only identities. ChangeSet stages intent; Plan captures and validates it; only Host.apply commits it. Lifecycle commands compile to that same transition mechanism.
- Configuration is immutable data: finite numbers, strings, booleans, null, dense arrays, and plain data records. Capture accepted input and validated output once; rollback reuses the validated committed output. Resource-bearing objects, functions, accessors, and Promises are not config.
- A Plan is Host-bound, revision-bound, and single-use. Foreign, stale, and consumed Plans fail before effects. Busy rejects without consuming the Plan. A JSON report is inspection data, never executable authority.
- Prepare every dependency layer before publishing any candidate listener or contribution. Foreground Service borrows, listener invocations, and contribution borrows prevent destructive changes to their owners. Preparation must not emit public Events.
- Lifetime alone owns task, acquisition, child, and resource release obligations. Shutdown seals ingress, cancels work, interrupts blocking I/O, joins it, and releases resources in ownership order. A failed child or consumer release cannot authorize releasing its parent or transitive providers. Instance release follows the actual bindings of each generation; a failed branch must not prevent independently safe branches from being released. Timeouts retain unresolved ownership and quarantine execution; they never prove that resources were released or authorize automatic retries.
- Consume standard `Symbol.dispose` and `Symbol.asyncDispose` protocols. Public resource handles do not require a second named disposal method. High-level adapters compose Lifetime operations instead of owning parallel teardown registries.
- Rollback reconstructs the previous declarations and reuses their validated configuration; it does not resurrect old objects or reverse external I/O. If cleanup or restoration cannot establish a healthy state, quarantine the entire Host, release independently safe branches, and report retained obligations. Quarantine is terminal: late completion updates diagnostics without restoring availability, retrying failed cleanup, or advancing the committed revision. Replacement requires the application to handle the old execution boundary and its external resources; constructing a new Host does not release them.
- Platform owns available and selected delivery revisions. Core owns the active implementation and its immutable origin as one commit. Admission precedes loading. A loaded candidate must still match its captured selection revision at commit; dependency closure and removals compile into one Core Plan.
- Snapshot views are projections of their owners. Host snapshots have one canonical read through `diagnostics.get()`, paired with the same view's `subscribe()`; do not add synonymous snapshot methods. Stable identity lasts until relevant state changes; observing task progress does not advance the committed graph revision. A projection may invalidate or render, but may not originate a competing lifecycle transition.

## Simplicity and performance

Apply Rob Pike's five rules of programming:

1. You cannot tell where a program will spend its time. Bottlenecks appear in surprising places, so do not guess; prove them with profiling.
2. Measure before tuning. Optimize only when measurements show that one part dominates the workload, then measure again and preserve a benchmark or behavioral guard when regression risk is meaningful.
3. Fancy algorithms are slow when `n` is small, and `n` is usually small. Consider real input sizes, constants, allocation, and locality before choosing a theoretically better algorithm.
4. Fancy algorithms are buggier than simple ones. Prefer simple algorithms and simple data structures unless evidence forces additional complexity.
5. Data dominates. Choose representations and ownership structures that make the algorithms self-evident. In Pike's phrasing, “write stupid code that uses smart objects.”

## Working rules

- Backward compatibility is not a goal during the current development stage. When a design changes, remove obsolete paths instead of adding compatibility layers, fallbacks, aliases, or migrations.
- Fix causes rather than symptoms. Do not accept a stopgap that is intended to be replaced later; make architectural decisions for the long term while breaking changes are inexpensive.
- Implement proven needs as complete vertical slices. Start with the smallest end-to-end version that works, finish it completely, and leave speculative features unimplemented.
- Prefer established, maintained libraries when they reduce total complexity or improve reliability. Check existing dependencies, documentation, and types before reimplementing functionality or adding another package.
- Let practical evidence from real applications correct theory without weakening the invariants that keep the system understandable.
- Tests should protect semantics and architectural boundaries rather than implementation trivia. For important regressions, verify that the test fails when the protected behavior is removed.
- Keep documentation, public types, execution behavior, and architecture guards consistent in the same change.
- Treat repository-local usage as no evidence for or against a public API. This is a framework: judge exports and extension points by responsibility, abstraction quality, and downstream utility, not merely by whether this repository calls them.
