# Runnable examples

```sh
pnpm examples
pnpm examples:benchmark
```

All examples live in root-level `examples/src` and consume public package entrypoints. The benchmark compares independent plugins with a dependency chain; timing is reported, never used as a correctness gate.

## Stage 1 · Atoms {#stage-1}

- 01 · Service and stable borrowing
- 02 · Events and contributions
- 03 · Structured resources
- 04 · Reactive generations

## Stage 2 · Composition {#stage-2}

- 05 · Configuration and failure
- 06 · Contracts and groups
- 07 · Read-only diagnostics
- 08 · External code and lazy activation

## Stage 3 · Applications {#stage-3}

- 09 · Planet media application
- 10 · Lynx workbench
- 11 · Declarative deployment
- 12 · Module-graph invalidation

The application chapters preserve domain ownership: Planet borrows contributions during asynchronous resolution; Lynx exposes declarative command metadata and invokes handlers through owner borrowing; the deployment controller serializes complete requests in submission order, combining each request's additions, updates and removals into one Core Plan; the hot module replacement adapter supplies its own import graph and submits one affected activation set.

Declarative deployment captures the desired Artifact array at submission before queuing selection, removal calculation and activation. The controller creates a dedicated Platform internally and exposes only Catalog, diagnostics, deployment and standard asynchronous disposal, preventing a second command path from rewriting selections within a request. The queue continues after a failed request. Platform owns selection and coordinates removal, Core owns committed implementations, and the application owns the Host. Loading, authorization and plugin callbacks cannot await a later request on the same controller because it would wait for the current request to finish.
