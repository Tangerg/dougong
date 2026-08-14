# Dougong repository guidance

## Project philosophy

- Treat explainability as an architecture test. In a coherent design, names, responsibilities, dependency directions, ownership, and runtime behavior agree; if the implementation is hard to explain through the public model, first assume that the model or implementation is wrong.
- Make important relationships explicit. Dependencies belong in declarations, ownership belongs in Lifetimes, capability identity belongs in Contracts, and runtime choices belong in ordinary parameters. Do not infer them from ambient state, call stacks, installation order, ancestor lookup, or hidden globals.
- Choose the simplest model that completely expresses the requirement. Do not confuse simplicity with missing semantics: keep irreducible complexity visible instead of hiding it behind magic.
- Keep the conceptual structure as flat and orthogonal as the domain permits. Add nesting only when it represents real ownership or composition, never merely to organize implementation details.
- Keep components modular and responsibilities sharply separated. Introduce an abstraction only when it clarifies an existing responsibility or a real composition point.
- Keep APIs sparse. Every public concept must earn its place, have one precise responsibility, and compose with the existing primitives.
- Design for the reader. Prefer ordinary TypeScript, intention-revealing names, small state machines, and local reasoning over clever metaprogramming, implicit proxies, decorators, or surprising control flow.
- Never let errors disappear accidentally. Propagate, aggregate, report, or explicitly classify them as cancellation; silence them only at a deliberate boundary whose behavior is documented.
- Refuse to guess when input, ownership, capability selection, or state is ambiguous. Reject the operation with a precise error and require the caller to make the choice explicit.
- Use namespaces deliberately. Stable Contract IDs, module boundaries, and package layers should prevent collisions and communicate ownership; do not turn Context into a bag of globally mixed names.

## Dougong architecture axioms

- Composition is preferred over inheritance. Higher-level capabilities are built from Service, Extension, Event, Lifetime, Plugin, Application, and their public protocols rather than framework base classes or privileged hooks.
- The same capability at the same abstraction layer has exactly one canonical API. Do not add aliases, parallel configuration forms, or alternate lifecycle paths. Special cases must use composition or a higher layer unless their underlying semantics are genuinely different.
- Higher layers may provide domain vocabulary and ergonomic sugar, but they must compile to Core primitives and must not duplicate registries, dependency graphs, transactions, resource ownership, observation protocols, or error semantics.
- Keep the core atoms orthogonal: Service is stable capability, Extension is an open contribution set, Event is a transient fact, and Lifetime is structured ownership. Do not make one atom secretly perform another atom's job.
- Group expresses installation ownership only. It is not a capability scope, provider shadow tree, permission boundary, or security sandbox.
- Stable Service dependencies are declared through `requires`; Core does not use a Service Locator, ambient scope, prototype-chain injection, or live Service proxy.
- Static multi-instance capabilities use explicit Contract families. Runtime tenant or workspace selection uses explicit Service parameters. Security isolation uses an Application, Worker, iframe, process, or another real isolation boundary.
- Resource ownership is structural and terminal resources detach from their owners. A retained handle must not keep an Application, Store, callback, payload, or completed task alive without a documented reason.
- Transactions expose only committed states. Setup declarations remain staged until their commit boundary, and failed changes roll back or fail closed rather than presenting a mixed runtime as healthy.
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
- Let practical evidence from real host applications correct theory without weakening the invariants that keep the system understandable.
- Tests should protect semantics and architectural boundaries rather than implementation trivia. For important regressions, verify that the test fails when the protected behavior is removed.
- Keep documentation, public types, runtime behavior, and architecture guards consistent in the same change.
- Treat repository-local usage as no evidence for or against a public API. This is a framework: judge exports and extension points by responsibility, abstraction quality, and downstream utility, not merely by whether this repository calls them.
