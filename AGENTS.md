# Dougong repository guidance

## Project philosophy

- Prefer designs that are coherent, readable, and easy to explain. Beauty here means that names, responsibilities, dependency directions, and runtime behavior agree with one another.
- Make important relationships explicit. Dependencies belong in declarations, ownership belongs in Lifetimes, capability identity belongs in Contracts, and runtime choices belong in ordinary parameters. Do not infer them from ambient state, call stacks, installation order, ancestor lookup, or hidden globals.
- Choose the simplest model that completely expresses the requirement. Do not confuse simplicity with missing semantics: irreducible complexity should remain visible instead of being hidden behind magic.
- Keep the conceptual structure as flat and orthogonal as the domain permits. Add nesting only when it represents real ownership or composition, never merely to organize implementation details.
- Keep APIs sparse. Every public concept must earn its place, have one precise responsibility, and compose with the existing primitives.
- Optimize for the reader. Prefer ordinary TypeScript, intention-revealing names, small state machines, and local reasoning over clever metaprogramming, implicit proxies, decorators, or surprising control flow.
- Special cases do not justify a second semantic path. Express them through composition or a higher layer unless the underlying abstraction is genuinely different.
- Let practicality correct theory. Use tests, measurements, and real host applications to challenge a design, while preserving the architectural invariants that make the system understandable.
- Never let errors disappear accidentally. Propagate, aggregate, report, or explicitly classify them as cancellation; silence them only at a deliberate boundary whose behavior is documented.
- Refuse to guess when input, ownership, capability selection, or state is ambiguous. Reject the operation with a precise error and require the caller to make the choice explicit.
- There should be one obvious canonical way to express each semantic operation. A convenience API is acceptable only when it mechanically compiles to that path and owns no second state machine.
- Implement a proven need now, completely. Leave speculative features unimplemented rather than shipping a premature abstraction that must later be replaced.
- Treat explainability as an architecture test. If an implementation is hard to explain in terms of the public model, first assume the model or implementation is wrong.
- Use namespaces deliberately. Stable Contract IDs, module boundaries, and package layers should prevent collisions and communicate ownership; do not turn Context into a bag of globally mixed names.

## Dougong architecture axioms

- Composition is preferred over inheritance. Higher-level capabilities are built from Service, Extension, Event, Lifetime, Plugin, Application, and their public protocols rather than framework base classes or privileged hooks.
- The same capability at the same abstraction layer has exactly one canonical API. Do not add aliases, parallel configuration forms, or alternate lifecycle paths.
- Higher layers may provide domain vocabulary and ergonomic sugar, but they must compile to Core primitives and must not duplicate registries, dependency graphs, transactions, resource ownership, observation protocols, or error semantics.
- Keep the core atoms orthogonal: Service is stable capability, Extension is an open contribution set, Event is a transient fact, and Lifetime is structured ownership. Do not make one atom secretly perform another atom's job.
- Group expresses installation ownership only. It is not a capability scope, provider shadow tree, permission boundary, or security sandbox.
- Stable Service dependencies are declared through `requires`; Core does not use a Service Locator, ambient scope, prototype-chain injection, or live Service proxy.
- Static multi-instance capabilities use explicit Contract families. Runtime tenant or workspace selection uses explicit Service parameters. Security isolation uses an Application, Worker, iframe, process, or another real isolation boundary.
- Resource ownership is structural and terminal resources detach from their owners. A retained handle must not keep an Application, Store, callback, payload, or completed task alive without a documented reason.
- Transactions expose only committed states. Setup declarations remain staged until their commit boundary, and failed changes roll back or fail closed rather than presenting a mixed runtime as healthy.
- Package and module dependencies point in one direction. Core and reactive remain independent foundations; Platform compiles external plugin concerns into Core operations; the facade remains a pure re-export layer.

## Working rules

- Backward compatibility is not a goal during the current development stage. When a design changes, remove obsolete paths instead of adding compatibility layers, fallbacks, aliases, or migrations.
- Fix causes rather than symptoms. Do not accept a stopgap that is intended to be replaced later; make architectural decisions for the long term while breaking changes are inexpensive.
- Grow the system in complete vertical slices. Start with the smallest end-to-end version that works, then add capabilities without trading a working product for unfinished infrastructure.
- Keep components modular and responsibilities sharply separated. Introduce a pattern or abstraction only when it makes an existing responsibility clearer or a real composition point possible.
- Prefer established, maintained libraries when they reduce total complexity or improve reliability. Check existing dependencies, documentation, and types before reimplementing functionality or adding another package.
- Do not optimize from intuition alone. Measure the relevant path, implement the simplest change supported by evidence, and preserve a benchmark or behavioral guard when regression risk is meaningful.
- Tests should protect semantics and architectural boundaries, not implementation trivia. For important regressions, verify that the test fails when the protected behavior is removed.
- Keep documentation, public types, runtime behavior, and architecture guards consistent in the same change.
- Treat repository-local usage as no evidence for or against a public API. This is a framework: judge exports and extension points by responsibility, abstraction quality, and downstream utility, not merely by whether this repository calls them.
