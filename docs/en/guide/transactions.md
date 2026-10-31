# Planning and execution

All installation changes follow `ChangeSet → Plan → apply`. `start` and `stop` compile into the same Engine transition instead of maintaining separate execution paths.

```ts
const change = host.change();
change.update(installation, { plugin: nextPlugin, config: nextConfig });
const plan = await host.plan(change);
inspectBeforeApplying(plan.report);
const result = await host.apply(plan);
console.log(result.stateRevision, result.affectedInstallations);
```

Planning captures configuration, runs schemas, validates contracts and groups, resolves bindings, computes affected closure and produces a read-only `PlanReport`. It does not run setup, acquire plugin runtime resources or publish listeners. Schema validators are application code and should avoid external effects. The report contains the baseline revision, operations, before/after bindings, origin changes, impact reasons, preparation order, stop order, publication order and atomic-publication guarantee.

A Plan is issued by one Host and can be consumed once. Before execution effects, apply checks authority, consumption and `stateRevision`. Another commit or a failure that changes running state invalidates old Plans. Task counts and notification counts do not.

Core issues executable Plans only: invalid declarations reject during `host.plan()`, so its report has no constant empty list of blockers. A permanent contract-kind conflict discovered at execution preflight consumes that Plan: correct the declarations and plan again. Platform’s data preview can still report actual blockers.

## Execution and results

Execution first checks foreground borrows on affected generations. A live borrow rejects with `HOST_BUSY` before execution effects and without consuming the Plan. Once execution is admitted, it seals affected old generations, joins their background work and releases resources, then prepares candidates in dependency order. After every candidate is ready, listeners, contributions, services and origin publish together.

Candidate failure cleans candidates and attempts to reconstruct the previous declarations using their validated configuration. Reconstruction creates new Instances; it does not revive disposed objects. Incomplete cleanup or restoration quarantines the Host. Failed consumers retain the providers they transitively use; other independently safe branches continue cleaning up and independent errors are aggregated.

| Outcome | Caller observes |
| --- | --- |
| Successful completion, including a no-op | Resolve with `{ stateRevision, affectedInstallations }` |
| Preflight rejection | Reject; handle the error code. When classified, `details.outcome` is `rejected` |
| Original declarations restored | Reject with `details.outcome === "restored"` |
| Safe restoration impossible | Reject with `details.outcome === "quarantined"` |

Atomic visibility applies to framework publications. Network requests, filesystem writes and effects in external systems do not automatically roll back. `plan.report.execution.externalEffectsRollback` is explicitly false.

Promise completion is the sole success signal; `ApplyResult` has no redundant constant success field. It returns the actual state revision and affected installations. Empty changes and repeated start or stop commands do not manufacture commits. Error `details.outcome` describes state after failure, not a second success-return protocol.

After a busy rejection, wait for the current work. The same unconsumed Plan can be applied if its baseline still matches. If another transition changed state, plan against the current state instead. Do not await a change that removes a borrowed service from inside that service's own callback. Copying a report cannot restore a stale or consumed Plan's authority.

## Application handling after quarantine {#quarantine}

**`quarantined` is terminal for the entire Host. There is no unquarantine, in-place recovery or automatic cleanup retry entrypoint.** It is the health boundary for one complete execution graph. The [design rationale](../reference/architecture.md#quarantine) explains why dependency-aware cleanup does not imply partial service recovery.

| Operation after quarantine | Behavior and purpose |
| --- | --- |
| `host.diagnostics.get()` and `subscribe()` | Read and observe errors, retained instances and resource obligations |
| `installation(id)`, `group(id)` and `explain(id)` | Inspect retained declaration identities and bindings; data is not execution authority |
| `change()`, `plan()`, `apply()`, `start()` and `stop()` | Reject with `HOST_QUARANTINED`; no alternate shutdown retry or recovery path |
| `host[Symbol.asyncDispose]()` | Uses stop and also rejects; standard disposal syntax does not erase an existing failure |
| New `host.use()` or contribution borrows | Reject access to sealed execution owners |
| Tasks, acquisitions or cleanup already in progress | May settle late; timeouts and sealed ingress cannot forcibly terminate arbitrary JavaScript |

`snapshot.unresolved` identifies retained Instances by installation and generation. Their Lifetime snapshots describe tasks, acquisitions, borrows, children and failed obligations. A provider can remain retained because its consumer has not exited, even if that provider has no cleanup error itself. Failed restoration setup can also quarantine a Host after all resources have been released, so **an empty unresolved list does not establish health**; read `snapshot.status`.

Shutdown already in progress may continue after a timeout and update diagnostics. This does not start another cleanup attempt or automatically leave quarantine. Diagnostic progress does not advance `stateRevision`.

Application code at the Host management boundary should:

1. Stop dispatching new requests to this Host and mark the corresponding functionality unavailable. Do not try recovery by replaying apply, start, stop or Platform activation; external effects may already have occurred.
2. Save a bounded `host.diagnostics.get()` snapshot and the direct operation failure, including installation, generation, failure phase and unresolved obligations. Continue observing the same diagnostic view if late completion matters. This explains an incident; it does not authorize recovery.
3. Have the actual application or executor owner handle the old boundary. For plugins in a terminable Worker or process, its supervisor reclaims the executor and checks connections, leases, locks and other exclusive resources according to the external system's contract. If code remains in the same realm and cannot be proven stopped, merely creating another Host is not safe takeover; escalate to a boundary that can actually be reclaimed.
4. Once the old boundary and exclusive external resources have been handled, create a new Host from application-owned declarations, configuration or Artifact selection. Diagnostic snapshots omit complete configuration and modules and are not executable recovery images.

Application code owns incident-specific resource handling; the framework does not rerun arbitrary cleanup callbacks. `shutdownTimeoutMs` supplies a shutdown waiting budget per Lifetime, not a total Host deadline; sequential cleanup can encounter several budgets, and none proves leaked resources have stopped. Features requiring independent availability should use separate Hosts; forcible termination also requires actual execution isolation.
