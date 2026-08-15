# Runnable examples

`@dougongjs/examples` is not a collection of static snippets. It is an **executable verification harness** for Dougong's public API. All nine scenarios run in sequence and pass through the repository's type check, test, coverage and build gate — every semantic these docs describe has matching runnable evidence here.

```sh
git clone https://github.com/Tangerg/dougong.git
cd dougong && pnpm install
pnpm examples
```

## The path

Three stages: single atoms, then their composition, then real host shapes.

### Stage 1 · Atoms

| # | Scenario | What you learn |
| --- | --- | --- |
| **01** | Service basics | Stable Services, declaring dependencies with `requires`, the boundary of `app.get()` |
| **02** | Extension and Event | Open contribution sets vs transient facts, and why they cannot be swapped |
| **03** | Reactive Lifetime | Signals, `observe()` and explicit resource rebuild: release the old, then build the new |

### Stage 2 · Composition

| # | Scenario | What you learn |
| --- | --- | --- |
| **04** | Transactions and Groups | Contract families for same-shape multi-instance, Group ownership trees, one atomic ChangeSet |
| **05** | Lazy Platform | Manifest validation, permission authorization, placeholders and the atomic swap on activation |

### Stage 3 · Real hosts

| # | Scenario | What you learn |
| --- | --- | --- |
| **06** | Planet | A media provider registry, playback Lifetimes, runtime selection and diagnostics |
| **07** | Lynx | Catalogs, workspace ownership, lazy activation and identity-preserving plugin updates |
| **08** | Declarative plan | Diffing a desired state into deployment records, then compiling to a ChangeSet; content revisions and rollback |
| **09** | HMR module graph | An explicit module graph, invalidation propagating along importers, atomic multi-plugin hot reload |

::: tip What 08 and 09 prove
These two correspond to subsystems that run into thousands of lines in mature plugin frameworks (a declarative config loader, a hot-reload engine).

Here each is roughly 200 lines, **using only the public API**, introducing no new primitive. That is a test of whether Core's abstractions are genuinely expandable — if HMR invalidation needed a framework interception point, those 200 lines could not exist.
:::

## Source and notes

- [Example sources](https://github.com/Tangerg/dougong/tree/main/packages/examples/src)
- [Example package notes](https://github.com/Tangerg/dougong/blob/main/packages/examples/README.md)

Each example is an exported async function returning a structured `ExampleResult`, driven by `suite.ts`. Tests assert their output, so **a stale example turns CI red** — they cannot quietly rot.

## Startup topology benchmark

The repository also carries a startup benchmark over independent and chained topologies:

```sh
pnpm examples:benchmark
```

It reports measurements only and **never gates CI on wall-clock thresholds**. Concurrency semantics are guarded by deterministic behavioural tests instead, so a noisy shared runner cannot produce flaky failures.

Typical shape (20 plugins each sleeping 20 ms):

| Topology | Description | Order of magnitude |
| --- | --- | --- |
| Independent | 20 plugins with no dependencies | close to a single plugin's cost — one concurrent layer |
| Chained | 20 plugins in a dependency chain | close to 20× — dependencies force serialization |

Which is exactly what layered concurrency should look like: parallel where it can be, serial where it must be.

## Next

- [Core concepts](./guide/concepts.md) — what each atom in these examples solves
- [Core API specification](./reference/core-api.md) — exact semantics for every API
