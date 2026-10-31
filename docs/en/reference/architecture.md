# Architecture and design rationale

Dougong separates capability declarations, execution changes, resource ownership and plugin delivery so applications, plugin authors and agents can understand the same facts. This page explains why the boundaries exist, their costs, and which behavior a convenient API must not hide. [Core API](./core-api.md) owns the export and signature reference, [Planning and execution](../guide/transactions.md) covers calling and failure handling, and the [project rules](https://github.com/Tangerg/dougong/blob/main/PROJECT_RULES.md) constrain implementation.

## One fact, one owner

Having one stored value is not enough to establish ownership. Ask who can advance the fact and whether another representation can change it independently.

| Fact | Sole authority | Other representations |
| --- | --- | --- |
| Committed declarations, bindings, Instances, execution revision and quarantine | Engine | Host exposes commands; Installation and Group are read-only identities; diagnostics are projections |
| Execution authority and consumption of one Plan | The issuing Host's plan authority | Plan exposes an immutable report; report JSON carries no execution authority |
| Tasks, acquisitions, borrows, child trees and release obligations | Lifetime | Task, Cleanup and resource snapshots expose bounded protocols |
| Available Artifact revisions | Catalog | Manifest and Reference describe immutable artifacts |
| Selected Artifact and selection revision | Registration | Platform activation captures and checks that selection |
| Committed implementation and its origin | One Core commit | Registration projects activeOrigin from Core |

After a failed activation, the selected revision and the running revision can differ. They describe different facts; neither needs to overwrite the other. A separate Platform value that independently advances the activated revision would compete with Core for the same fact.

`host.diagnostics.get()` is the canonical Host snapshot read, and `subscribe()` observes invalidation. Reads and subscriptions share one SnapshotView, so there is no synonymous snapshot method. `explain(id)` answers the narrower question of an installation's Service bindings. Snapshots may be cached, serialized or rendered, but cannot submit execution state.

## Why the primitives stay orthogonal

| Primitive | Expresses | Does not own |
| --- | --- | --- |
| Service | One capability under a stable contract identity | Dynamic lookup, implicit routing or indefinite borrowing |
| ExtensionPoint | An open collection of contributions | Consumer ordering, selection or business scheduling |
| Event | A transient fact broadcast with awaited listener completion | Current state, reliable message delivery or transaction commit |
| Lifetime | Runtime resources and their shutdown obligations | Installation naming, admission or business dependency selection |

A Plugin composes these primitives. A command system can declare commands through an ExtensionPoint, execute through a contribution's `use()`, announce business facts with an Event, and release listeners and tasks through a Lifetime. It needs neither a command-plugin base class nor another registration and disposal protocol. UI state and business scheduling belong to application code, which may compose `@dougongjs/reactive` without putting those responsibilities in Engine.

Group expresses installation ownership and bulk removal. It does not make identically named Services shadow one another or establish an authorization or security boundary. Static multi-instance capabilities use explicit Contract identities; execution-time tenant or workspace selection uses Service parameters. Declarations and call sites therefore explain which capability is being used.

## Why dependency references stay stable within a generation

Service dependencies appear in `requires`, and resolved values appear in `ctx.deps`. Each contract has one provider in a Host's composition graph; an absent optional dependency is `undefined`. Replacing a provider rebuilds affected consumers instead of silently switching the implementation behind their existing objects.

This can increase the rebuild scope, but consumers reason about ordinary TypeScript values and functions without a proxy changing its target between calls. The binding graph also supports plan explanation, startup ordering and safe shutdown. Dynamic ExtensionPoint membership is not a static Service dependency edge; executing a contribution borrows its owner instead.

Application code uses `host.use(contract, callback)`. The borrow lasts until the callback's full result settles. A change that would destroy that generation rejects with `HOST_BUSY` before effects while a foreground borrow exists. Once a transition seals entry, affected generations accept no new borrows. This gives references a useful boundary, but TypeScript cannot prevent application code from saving a callback value globally; callers must honor the borrowing protocol.

## Why planning precedes execution

ChangeSet captures intent, Plan fixes validation results and execution arrangements at one `stateRevision`, and Engine executes those arrangements. CLI, UI, agents and Platform all use `change → plan → apply`; preview does not have an approximate planner separate from execution rules.

Planning checks the final declaration graph, configuration, bindings and impact without running plugin setup. Accepted configuration and validated output are captured as immutable data, so later input mutation cannot change an approved plan. Validators remain application code and should avoid external effects; the framework cannot make arbitrary validators pure. Restoring previous declarations reuses their validated output rather than consulting a validator whose answer may have changed.

A Plan binds Host identity, state revision and one-use authority. Serializing its report transmits explanation, not executable authority across processes. Foreign, stale and consumed Plans fail before execution effects. Busy rejection does not consume a Plan, although its baseline must still match when attempted later. Task progress updates diagnostics without advancing graph revision; an empty operation does not manufacture a new graph commit.

Successful Promise completion communicates success. `ApplyResult` carries only `stateRevision` and `affectedInstallations`, without a constant success discriminator repeating the same result. Failures reject, and structured errors distinguish rejection, restoration and quarantine.

## Where atomic publication ends

A change in a running Host stops affected old generations, then prepares candidates in dependency order. Once all candidates are ready, services, event listeners, contributions and origin publish together. Candidate listeners and contributions are invisible before commit, and setup cannot emit public Events. Unaffected instances can remain in place; an ordinary local change does not restart the whole Host.

Atomicity covers framework publications. It does not promise zero downtime, provide a database transaction, or undo network requests, filesystem writes or module evaluation effects. Business transactions and compensation belong at their actual external-system boundaries; Core cannot infer them.

After preparation fails, candidates must be cleaned safely before new Instances reconstruct the previous declarations using their validated configuration. Restoration reestablishes the old declaration graph; it does not revive disposed JavaScript objects. A restored operation still rejects because its requested new state was not achieved. Failed restoration or incomplete cleanup quarantines the entire Host.

## Why release follows relationships rather than array positions

An Instance's Lifetime owns its resources. Shutdown seals entry, withdraws publications and cancels work, then interrupts blocking operations, joins tasks and acquisitions, and releases resources. A failed child cannot authorize its parent's release, and a failed consumer cannot authorize its providers' release: code that has not exited may still use them.

Suppose A uses B, B uses C, and D is independent. If A cannot clean up, B and C must remain owned while D can still be released. If an independent E also fails, its error must be reported as well. A being the first failure in a linear shutdown list does not justify skipping every later instance. Release safety follows each generation's actual bindings, not the candidate graph or another generation with the same installation ID.

The scope of blocked release differs from the scope of unavailable service. Cleanup releases independent branches wherever it can establish safety and retains obligations whose release is unproven. A timeout exhausts the waiting budget; it does not prove that underlying work has stopped. Calling shutdown again cannot automatically retry cleanup that may already have performed some external effects.

## Why quarantine is Host-wide and terminal {#quarantine}

A Host promises the health of one complete execution graph. Quarantine means Engine can no longer establish that promise, whether because of a shutdown timeout, a cleanup failure or failed restoration. Serving the remainder while retaining a failed branch would require explicit partial availability, cross-branch borrowing and recovery protocols. An installation failure flag alone cannot establish those guarantees.

The current model makes an explicit choice: **quarantine is terminal for the entire Host, with no unquarantine, cleanup retry or in-place recovery API.** It withdraws availability, rejects new mutations and Service borrows, and keeps resource obligations observable. The cost is that one plugin's cleanup failure makes its whole Host unavailable. Dependency-aware cleanup reduces retained resources; it does not change that availability contract.

Shutdown work already in progress may continue after its deadline, and diagnostics reflect late completion. A shrinking `unresolved` list does not make the Host healthy: releasing resources is not equivalent to restoring the whole declaration graph, and the original operation has already failed. Application code cannot erase diagnostics, repeat start or recreate Platform to declare the incident resolved.

Separate Hosts can narrow logical failure domains for independently available features. Code that must be forcibly terminated needs a reclaimable Worker, process or another actual execution boundary. Multiple Hosts in one JavaScript thread cannot terminate leaked asynchronous work or undo external effects. A replacement Host still requires dealing with the old execution boundary and its external resources; see [Application handling after quarantine](../guide/transactions.md#quarantine).

## Why delivery does not own another execution truth

Platform discovers artifacts, records selection, authorizes and loads, then compiles the dependency closure and removals into one Core Plan. An older load cannot commit after selection changes. Admission precedes loading and is checked again before activation. Core commits implementation and origin together, so delivery does not introduce an unexplained intermediate state by patching origin afterward.

Admission permits an attempt; it does not sandbox same-realm JavaScript. A Loader must define its integrity guarantees, isolation and module-cache behavior. Manifest permissions and Group membership cannot constrain arbitrary plugin access to the global environment.

## Physical directories follow logical responsibility

`dougong` directly implements the kernel. `@dougongjs/platform` is a delivery layer depending on it; `@dougongjs/reactive` is independent and composes through structural protocols. Packages have actual responsibilities, without a second Core facade merely forwarding the same capabilities.

| Directory | Responsibility |
| --- | --- |
| `packages/dougong/src/contracts` | Identity, protocols, statuses, error and logging contracts |
| `packages/dougong/src/internal` | Shared low-level record, queue and protocol primitives |
| `packages/dougong/src/observation` | Stable snapshots and publication |
| `packages/dougong/src/lifetime` | Resource ownership and shutdown |
| `packages/dougong/src/events` | Owned event listeners and awaited broadcast |
| `packages/dougong/src/contributions` | Owned contribution collections |
| `packages/dougong/src/composition` | Plugin declarations, configuration, graph and Plan |
| `packages/dougong/src/inspection` | Derived diagnostic projections |
| `packages/dougong/src/execution` | Instance execution and the single Engine |
| `packages/platform/src/artifacts` | Immutable distribution declarations |
| `packages/platform/src/catalog` | Known Artifacts and selection handles |
| `packages/platform/src/admission` | Admission policy |
| `packages/platform/src/loaders` | Module delivery |
| `packages/platform/src/activation` | Selection-aware compilation to Core Plans |
| `packages/reactive/src` | Signals, Readable bridge and owned observation |
| `examples/src` | Application-level composition |
| `tooling/architecture` | Responsibility and emitted API guards |
| `tooling/release` | Artifact verification and publishing |
Lower responsibilities do not import higher ones. Contracts do not import execution. Lifetime imports neither events nor contributions; both compose Lifetime publication and borrowing primitives. Inspection projects stable diagnostics; reusable observation belongs to its own lower-level directory.

Cross-package imports use only declared exports. `dougong/advanced` is a formal entrypoint for downstream composition primitives, with no mutable core registry or private control port. Physical directories follow these responsibilities. Unknown responsibility directories fail the guard and require an explicit design decision.

## People and agents share the same protocols

Structured `PlanReport` describes proposed changes and their impact. `HostSnapshot` describes committed state and retained obligations. Error details describe the failing phase and outcome. UI, CLI and agents project those facts instead of rebuilding a separate state machine from log messages.

Reports do not copy actual configuration, service objects or functions. `describePlugin` projects capabilities from the same Plugin declaration. Configuration schemas require an explicit standard exporter; they cannot be guessed from arbitrary TypeScript types or live service objects. When no exporter exists, the description says so rather than presenting an apparently complete but unreliable automation contract.

## Design references

The design report compares capability declarations, lifecycle, delivery and isolation separately. These primary references inform specific boundaries rather than requiring wholesale replication of a framework.

- [Backstage services](https://backstage.io/docs/backend-system/architecture/services/) and [extension points](https://backstage.io/docs/backend-system/architecture/extension-points/)
- [pluggy](https://pluggy.readthedocs.io/en/stable/)
- [OSGi Declarative Services](https://docs.osgi.org/specification/osgi.cmpn/8.0.0/service.component.html)
- [VS Code activation events](https://code.visualstudio.com/api/references/activation-events)
- [Vite plugin API](https://vite.dev/guide/api-plugin) and [Rollup plugin development](https://rollupjs.org/plugin-development/)
- [Fx lifecycle](https://uber-go.github.io/fx/lifecycle.html)
- [ECMAScript resource management](https://tc39.es/ecma262/multipage/managing-memory.html)
- [Standard Schema](https://standardschema.dev/)
