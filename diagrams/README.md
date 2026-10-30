# Architecture diagrams

These diagrams describe the current responsibility boundaries. Source links are repository-relative so a revision cannot silently claim evidence from another commit.

## Package dependencies

```mermaid
flowchart TD
    Examples["examples"] --> Platform["@dougongjs/platform"]
    Examples --> Core["dougong"]
    Examples --> Reactive["@dougongjs/reactive"]
    Platform --> Core
    Reactive -. "structural owner protocol" .-> Lifetime["LifetimeContext"]
    Core --> Lifetime
```

The dashed relationship is protocol compatibility, not a package dependency. Reactive imports no other package. Platform consumes only `dougong` and its formal `dougong/advanced` subpath.

Sources: [package directions](../tooling/architecture/check-layers.mjs), [Core entry](../packages/dougong/src/index.ts), [Platform entry](../packages/platform/src/index.ts), [reactive protocol](../packages/reactive/src/protocol.ts).

## Plan and execution authority

```mermaid
flowchart TD
    Intent["ChangeSet"] --> Planner["Planner"]
    State["Committed state + stateRevision"] --> Planner
    Planner --> Plan["Immutable Plan + report"]
    Plan --> Gate{"Host authority, revision, unused?"}
    Gate -->|Valid| Engine["Engine transition"]
    Gate -->|Invalid| Rejected["Rejected without execution effects"]
    Engine -->|Commit| State
    Engine -->|Prepare failure, cleanup safe| Restored["Restore original declarations"]
    Restored --> State
    Engine -->|Unresolved obligations| Quarantined["Quarantine + diagnostics"]
```

Services, listeners, contributions and origin become visible in the same publication boundary. Resource obligations remain owned after failed shutdown. External network or filesystem effects are outside the atomic-publication guarantee.

Sources: [Planner](../packages/dougong/src/composition/planner.ts), [Plan authority](../packages/dougong/src/composition/plan.ts), [Engine](../packages/dougong/src/execution/engine.ts), [Lifetime](../packages/dougong/src/lifetime/lifetime.ts).
