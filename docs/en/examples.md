# Runnable examples

`@dougongjs/examples` is not a folder of static snippets. It is an **executable harness** over Dougong's public API: twelve chapters run in order and pass through the repository's typecheck, test, coverage and build gates — so every semantic claimed in these docs has runnable evidence here.

```sh
git clone https://github.com/Tangerg/dougong.git
cd dougong && pnpm install
pnpm examples
```

## How the path is built

Three stages, twelve chapters, each adding **exactly one rung**:

| Stage | Chapters | What you are learning |
| --- | --- | --- |
| **1 · Atoms** | 01–04 | One primitive per chapter, and the problem it exists to solve on its own |
| **2 · Composition** | 05–08 | The primitives together: what failure looks like, how identity is spelled out, how the runtime is observed, how external code arrives |
| **3 · Real hosts** | 09–12 | The first eight chapters arranged into real application shapes, **introducing no new primitive** |

::: tip "Strictly progressive" is a test
The `concepts` array in `example.ts` is both the syllabus and the reading order. Each chapter declares which concepts it is the **first** to use, and the test concatenates all twelve declarations and compares them to `concepts` for exact equality.

A repeated concept, an inverted order, or a chapter that adds nothing new — any one of them turns CI red. So this table cannot drift away from the code.
:::

## Stage 1 · Atoms {#stage-1}

One primitive at a time. After these four chapters you know what four of the six atoms are responsible for, and why they cannot substitute for one another.

| # | Scenario | New concepts | The point |
| --- | --- | --- | --- |
| **01** | Service | `service` `provides` `requires` `app.get` | Installation order is not startup order; the declared dependency edge is |
| **02** | Extension + Event | `extension` `contribute` `extension-view` `event` `contribution-dispose` | An Extension holds current contributions; an Event keeps nothing — it is not a query API |
| **03** | Lifetime | `cleanup` `child-lifetime` `spawn` `abort-signal` | Everything hangs off one tree, released in **reverse registration order**; a subtree can be released on its own |
| **04** | Reactive | `signal` `computed` `batch` `observe` | `computed` derives purely and owns nothing; `observe()` is the single seam between "a value changed" and "a resource is rebuilt" |

::: details What chapter 03 actually prints
```
- Setup acquired open:index → open:window → open:session.
- Disposing the child released only its own subtree: cancel:session-watcher → close:session.
- Stopping released the rest in reverse: cancel:editor-watcher → close:window → close:index.
```
The window is built on the index, so the window closes first. That order is what the test asserts — remove the `.reverse()` inside Core and this line turns red immediately.
:::

## Stage 2 · Composition {#stage-2}

The primitives start meshing. These four chapters cover exactly what a small project can paper over and a large one cannot.

| # | Scenario | New concepts | The point |
| --- | --- | --- | --- |
| **05** | Config and failure | `config-schema` `config-validation` `change-set` `setup-failure` `rollback` | Validation happens **before** anything is stopped; rollback is work undone, not work skipped |
| **06** | Contract families and Groups | `contract-family` `group` `atomic-commit` `group-removal` | Many instances of one shape use an explicit Contract family; a Group expresses installation ownership only |
| **07** | Diagnostics | `diagnostics-view` `lifetime-snapshot` `terminal-detachment` `view-finalization` | Terminal resources detach from their owner; after shutdown the view finalizes into data instead of retaining the Application |
| **08** | Platform | `manifest` `permissions` `placeholder` `activation` | Registration ≠ activation; the placeholder-to-implementation swap is one committed step |

::: warning Chapter 05 is the turning point of the path
The first four chapters live in a world where everything works. Chapter 05 is the first to ask: **what if the declaration is wrong, and what if `setup` throws.**

The answer is Dougong's most distinctive semantic, and its main trade-off: if any plugin in a ChangeSet fails, the whole change rolls back. The audit plugin in the example genuinely **did start**, then was undone — `started 1 time and was released 1 time`.

If your situation needs "one plugin dies, the others keep running" instead, decide that here.
:::

## Stage 3 · Real hosts {#stage-3}

No new API is introduced. These four chapters arrange the previous ones into shapes real applications take.

| # | Scenario | New concepts | What it proves |
| --- | --- | --- | --- |
| **09** | Planet | `runtime-selection` `live-provider-swap` `group-scoped-platform` | Adding and removing providers never restarts the player — an Extension is not a dependency edge |
| **10** | Lynx | `domain-catalog` `workspace-ownership` `plugin-update` | Command uniqueness is domain policy; a root consumer sees the Group's contribution, so a Group is not a scope |
| **11** | Declarative plan | `desired-state` `content-revision` `platform-change-set` | Desired state diffed into one ChangeSet; identity from the manifest name, change from an explicit revision |
| **12** | HMR module graph | `module-graph` `invalidation-closure` `multi-plugin-hmr` | Invalidation propagates along importers; two plugins change version and the observer sees exactly 1 commit |

::: tip What 11 and 12 are for
These two chapters correspond to subsystems that mature plugin frameworks ship as thousands of built-in lines: a declarative config loader and a hot-reload engine.

Here each is roughly 200 lines, uses **only the public API**, and introduces no new primitive. That is the test of whether Core's abstractions are open enough to be composed on — if HMR invalidation required a framework-provided interception point, those 200 lines could not be written.
:::

## The shape of a chapter

Each chapter is an exported async function that creates and fully releases its own Application:

```ts
import { diagnostics } from "@dougongjs/examples"

const result = await diagnostics()
console.log(result.facts)
```

The `facts` in the returned value record what the run **actually observed**, not a restatement of design intent. Tests assert the important semantics inside them, so a stale example turns CI red — they cannot quietly rot.

- [Example sources](https://github.com/Tangerg/dougong/tree/main/packages/examples/src)
- [Package README](https://github.com/Tangerg/dougong/blob/main/packages/examples/README.md)

## Startup-topology benchmark

The repository also includes a startup benchmark for the independent and chained topologies:

```sh
pnpm examples:benchmark
```

It only prints measurements and **never uses a wall-clock threshold as a CI condition**. Concurrency semantics are guarded by deterministic behavioral tests, so jitter on a shared runner cannot manufacture a flaky failure.

Typical result (20 plugins each sleeping 20ms):

| Topology | Description | Order of magnitude |
| --- | --- | --- |
| Independent | 20 plugins with no dependencies | Close to a single plugin — one layer, run concurrently |
| Chained | 20 plugins in a dependency chain | Close to 20× — dependencies force serialization |

That is exactly what layered concurrency should look like: concurrent where it can be, serial where it must be.

## Next

- [Core concepts](./guide/concepts.md) — what each atom in the examples is for
- [Transactions and change](./guide/transactions.md) — the full rules behind chapter 05's rollback
- [Core API specification](./reference/core-api.md) — the precise semantics of every API
