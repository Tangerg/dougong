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

- 09 · Planet media host
- 10 · Lynx workbench
- 11 · Declarative deployment
- 12 · Module-graph invalidation

The application chapters preserve domain ownership: Planet borrows contributions during asynchronous resolution; Lynx exposes declarative command metadata and invokes handlers through owner borrowing; deployment combines additions, updates and removals into one Core Plan; the hot module replacement adapter supplies its own import graph and submits one affected activation set.
