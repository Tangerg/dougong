# Dougong repository guidance

## Domain vocabulary

Every noun names exactly one lifecycle stage. Reading the name must be enough to
know which layer an object belongs to, who owns it, and what may be done to it —
without opening the implementation.

```text
Manifest + Reference → Artifact → Registration      (Platform: code from outside the build)
                                        ↓ compiles to
                                  Plugin → Installation  (Core: stable identity)
                                               ↓ owns while active
                                            Instance     (Core: internal execution)

Host owns one Engine; the Engine coordinates the committed Installation graph
and its active Instances.
```

| Noun | Stage | Layer |
| --- | --- | --- |
| `Plugin` | A declaration. Reusable, inert, owns nothing | Core |
| `Installation` | The stable identity of one installed Plugin. Its declaration may be replaced; its identity and position may not | Core |
| `Instance` | One active execution of an Installation. Internal and replaced on restart | Core |
| `Group` | An installation-ownership subtree. Nothing else | Core |
| `Installer` | The capability to install into something — implemented by `Host` and `Group` | Core |
| `Engine` | The internal owner of committed Contracts, Services, Events, Contributions, Instances and graph transitions | Core |
| `Host` | The execution boundary Dougong owns: commands, transactions and orchestration | Core |
| `Artifact` | A manifest plus a reference that can load a Plugin | Platform |
| `Registration` | The stable identity of one Artifact admitted to a Platform | Platform |
| `Platform` | The delivery boundary: declaration, authorization, loading, activation | Platform |

Three words that used to mean "host" are now distinct, and must stay distinct in
code, comments, error messages and documentation:

- **`Host`** — the Dougong execution boundary. A product may run several.
- **application code** — the code that embeds Dougong and calls `host.get()`. Never called a host.
- **runtime** — the JavaScript environment (Node, a browser, a WebView). Never called a host.
- **`*Port`** — an internal collaborator protocol (`LifetimePort`, `ChangePort`). Never called a host either.

Retired names must not return. `scripts/check-api-surface.mjs` holds the banlist
and reads the built `dist/index.d.ts` of every package, so an `export *` cannot
smuggle one back in.

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
- Static multi-instance capabilities use explicit Contract families. Execution-time tenant or workspace selection uses explicit Service parameters. Security isolation uses a Host, Worker, iframe, process, or another real isolation boundary.
- Resource ownership is structural and terminal resources detach from their owners. A retained handle must not keep a Host, Store, callback, payload, or completed task alive without a documented reason.
- Transactions expose only committed states. Setup declarations remain staged until their commit boundary, and failed changes roll back or fail closed rather than presenting mixed execution state as healthy.
- Package and module dependencies point in one direction. Core and reactive remain independent foundations; Platform compiles external plugin concerns into Core operations; the facade remains a pure re-export layer.

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
