# Planning and execution

All installation changes follow `ChangeSet → Plan → apply`. `start` and `stop` compile into the same Engine transition instead of maintaining separate execution paths.

```ts
const change = host.change();
change.update(installation, { plugin: nextPlugin, configuration: nextConfiguration });
const plan = await host.plan(change);
inspectBeforeApplying(plan.report);
const result = await host.apply(plan);
console.log(result.stateRevision, result.affectedInstallations);
```

Planning captures configuration, runs schemas, validates contracts and groups, resolves bindings, computes affected closure and produces a read-only `PlanReport`. It does not run setup, acquire plugin runtime resources or publish listeners. Schema validators are application code and should avoid external effects. The report contains the baseline revision, operations, before/after bindings, origin changes, impact reasons, preparation order, stop order and atomic-publication guarantee.

A Plan is issued by one Host and can be consumed once. Before execution effects, apply checks authority, consumption and `stateRevision`. Another commit or a failure that changes running state invalidates old Plans. Task counts and notification counts do not.

Core issues executable Plans only: invalid declarations reject during `host.plan()`, so its report has no constant empty list of blockers. A permanent contract-kind conflict discovered at execution preflight consumes that Plan: correct the declarations and plan again. Platform’s data preview can still report actual blockers.

If another operation commits while schema validation is pending, planning rejects with [`PLAN_STALE`](../reference/errors.md); on quarantine it rejects with [`HOST_QUARANTINED`](../reference/errors.md). Build a new change against the current Host. An uncommitted Installation in an issued Plan becomes `removed` as soon as that revision ends. Keeping an obsolete Plan for its report does not retain the old executable payload.

Contract kinds belong to the Host registry, so a live plugin or application can claim a kind without a graph commit. Planning checks its graph against those claims before issuing a Plan. If a different kind wins while candidate setup is running, admission rejects before publication: candidate cleanup and restoration follow the same path as a failed setup. A conflict by itself does not quarantine the Host.

Call `host.plan(change, signal)` to withdraw one planning request. Cancellation rejects with the signal’s reason, retires its pending Installations and leaves other Plans at that revision valid. Once issued, a Plan follows its normal revision and single-use rules.

Invalidation ends the waiting `plan()` immediately, even if its validator never settles. No later validator is started for the obsolete change. A validator already running may finish its own external work; that result cannot affect the Host.

## Execution and results

Execution first checks foreground borrows on affected generations. A live borrow rejects with [`HOST_BUSY`](../reference/errors.md) before execution effects and without consuming the Plan. Once execution is admitted, it seals affected old generations, joins their background work and releases resources, then prepares candidates in dependency order. After every candidate is ready, listeners, contributions, services and origin publish together.

`start(signal?)` and `apply(plan, signal?)` accept cancellation of the execution request. Cancellation while queued or validating startup ends the request; a late validator result cannot run setup, and a Plan that has not begun execution remains unconsumed. Once execution begins, Engine delivers cancellation to the current preparation layer's Lifetimes and uses the same recovery path to clean candidates, join actual setup settlement, and reconstruct the previous declarations or quarantine. Prepared providers remain owned until their consumers finish cleanup.

Cancellation during execution reports `TRANSITION_FAILED` with `details.outcome: "restored"` after successful cleanup or reconstruction, or `HOST_QUARANTINED` when cleanup or recovery cannot complete. The original cancellation reason remains in the failure cause. A final check accepts cancellation before commit; once publication begins, late cancellation cannot rewrite the committed outcome. Cancellation cannot undo external I/O.

While startup or change is unsettled, `stop()` and `host[Symbol.asyncDispose]()` still reject with `HOST_BUSY`, so a validator, setup or cleanup callback cannot await itself. Applications cancel their own execution request and then await its outcome.

Each waiting budget belongs to the owner of its actual obligations. Neither falls back to the other or limits normal startup:

| Host option | Scope |
| --- | --- |
| `shutdownTimeoutMilliseconds` | Shutdown already initiated by each Lifetime; expiry retains its actual tasks and cleanup obligations |
| `restorationTimeoutMilliseconds` | Engine preparation of the previous declarations after candidate cleanup; all dependency layers share this one budget, and expiry cancels the current restoration layer before cleanup and quarantine |

Both are optional; omitting one leaves its corresponding wait unbounded. Configured values must be positive finite milliseconds no greater than `2 ** 31 - 1`. A failure receipt for non-cooperative restoration setup requires both restoration and shutdown budgets. Restoration uses an independent signal rather than inheriting the already cancelled replacement request, and commit clears its timer. A deadline retains the actual obligations and quarantines the Host rather than declaring release; forceful termination of arbitrary code requires Worker or process isolation.

Candidate failure cleans candidates and attempts to reconstruct the previous declarations using their validated configuration. Reconstruction creates new Instances; it does not revive disposed objects. Incomplete cleanup or restoration quarantines the Host. Failed consumers retain the providers they transitively use; other independently safe branches continue cleaning up and independent errors are aggregated.

Within a dependency layer, preparation starts in committed declaration order. Asynchronous setup may finish in any order. Publication follows the same declaration order. Updates preserve an Installation’s position. A new Installation takes its position when its draft commits. A single change can remove overlapping Group subtrees. Its impact report lists the Installations removed implicitly by those Groups once in committed declaration order.

`stopOrder` describes the dependency order, not wall-clock completion order. Independent consumers may shut down concurrently. Each provider waits for the consumers bound to that generation to exit successfully.

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

An existing Installation handle retains only its final status and origin. Open ChangeSets are revoked, release their staged declarations, and cannot accept new work; their uncommitted Installations become `removed`. Only the diagnostics view needs to track late cleanup.

| Operation after quarantine | Behavior and purpose |
| --- | --- |
| `host.diagnostics.get()` | Read errors, retained instances and resource obligations; the final snapshot remains readable after release completes |
| `host.diagnostics.subscribe()` | Observe actual late progress; subscriptions end after every obligation and transition completes and final notifications are delivered, and later subscriptions are rejected |
| `installation(id)`, `group(id)` and `explain(id)` | Inspect retained declaration identities and bindings; data is not execution authority |
| `change()`, `plan()`, `apply()`, `start()` and `stop()` | Reject with [`HOST_QUARANTINED`](../reference/errors.md); no alternate shutdown retry or recovery path |
| `host[Symbol.asyncDispose]()` | Uses stop and also rejects; standard disposal syntax does not erase an existing failure |
| New `host.use()` or contribution borrows | Reject access to sealed execution owners |
| Tasks, acquisitions or cleanup already in progress | May settle late; timeouts and sealed ingress cannot forcibly terminate arbitrary JavaScript |

`snapshot.unresolved` identifies retained Instances by installation and generation. Their Lifetime snapshots describe tasks, acquisitions, borrows, children and failed obligations. A provider can remain retained because its consumer has not exited, even if that provider has no cleanup error itself. Failed restoration setup can also quarantine a Host after all resources have been released, so **an empty unresolved list does not establish health**; read `snapshot.status`.

Engine continues the same retirement after a timeout. It cancels cooperative foreground work when that generation can safely enter shutdown and joins the borrow before releasing its resources. A provider's cancellation and first release wait for its actual consumers to exit successfully; an expired consumer receipt cannot authorize them. Late success therefore also unblocks first releases that were previously deferred. Failure receipts can return while this work remains unresolved, and later release failures update diagnostics and reach the Host error reporter. Failed callbacks are never retried, quarantine remains terminal, and progress does not advance `stateRevision`.

Engine seals observation after terminal execution and actual release finish. Diagnostics and Host contribution views retain their final read-only snapshots while detaching the execution graph and callbacks; they neither retry cleanup nor decide execution state. Pending obligations keep observation active. Ordinary stop/start preserves usable views.

Application code at the Host management boundary should:

1. Stop dispatching new requests to this Host and mark the corresponding functionality unavailable. Do not try recovery by replaying apply, start, stop or Platform activation; external effects may already have occurred.
2. Save a bounded `host.diagnostics.get()` snapshot and the direct operation failure, including installation, generation, failure phase and unresolved obligations. Continue observing the same diagnostic view if late completion matters. This explains an incident; it does not authorize recovery.
3. Have the actual application or executor owner handle the old boundary. For plugins in a terminable Worker or process, its supervisor reclaims the executor and checks connections, leases, locks and other exclusive resources according to the external system's contract. If code remains in the same realm and cannot be proven stopped, merely creating another Host is not safe takeover; escalate to a boundary that can actually be reclaimed.
4. Once the old boundary and exclusive external resources have been handled, create a new Host from application-owned declarations, configuration or Artifact selection. Diagnostic snapshots omit complete configuration and modules and are not executable recovery images.

Application code owns incident-specific resource handling; the framework does not rerun arbitrary cleanup callbacks. `shutdownTimeoutMilliseconds` supplies a shutdown waiting budget per Lifetime, not a total Host deadline; sequential cleanup can encounter several budgets, and none proves leaked resources have stopped. Features requiring independent availability should use separate Hosts; forcible termination also requires actual execution isolation.
