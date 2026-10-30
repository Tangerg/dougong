# Planning and execution

All installation changes follow `ChangeSet → Plan → apply`. `start` and `stop` compile into the same Engine transition instead of maintaining separate execution paths.

```ts
const change = host.change();
change.update(installation, { plugin: nextPlugin, config: nextConfig });
const plan = await host.plan(change);
inspectBeforeApplying(plan.report);
const result = await host.apply(plan);
// result.outcome === "committed"
```

Planning captures configuration, runs schemas, validates contracts and groups, resolves bindings, computes affected closure and produces a read-only `PlanReport`. It does not run setup, acquire resources or publish listeners. The report contains the baseline revision, operations, before/after bindings, origin changes, impact reasons, preparation order, stop order, publication order and atomic-publication guarantee.

A Plan is issued by one Host and can be consumed once. Before execution effects, apply checks authority, consumption and `stateRevision`. Another commit or a failure that changes running state invalidates old Plans. Task counts and notification counts do not.

Execution prepares candidates in dependency order. Candidate listeners, contributions and services become visible together. Affected old generations reject new work, join existing uses and release resources. Candidate failure cleans candidates and attempts to restore the original declarations. If resource safety cannot be established, the Host becomes quarantined.

| Outcome | Caller observes |
| --- | --- |
| Committed | Resolve with `{ outcome: "committed", stateRevision, affectedInstallations }` |
| Preflight rejection | Reject with `DougongError.details.outcome === "rejected"` |
| Original declarations restored | Reject with `details.outcome === "restored"` |
| Safe restoration impossible | Reject with `details.outcome === "quarantined"` |

Atomic visibility applies to framework publications. Network requests, filesystem writes and effects in external systems do not automatically roll back. `plan.report.execution.externalEffectsRollback` is explicitly false.

A busy Host rejects reentrant mutations. Wait for the current operation and plan again. Do not await a change that removes a borrowed service from inside that service's own borrowed callback.
