# Core concepts

Each fact has one owner. Other objects hold references or expose read-only projections.

| Concept | Owned fact |
| --- | --- |
| Service | One capability protocol under a stable identity |
| ExtensionPoint | The protocol of an open collection of contributions |
| Event | The payload protocol of a transient broadcast; emit awaits listener completion |
| Plugin | Configuration schema, requirements, provisions and setup |
| Installation | Stable installation identity with read-only status and origin projected from Engine |
| Instance | Services and Lifetime from one setup execution |
| ChangeSet | Declaration intent awaiting planning |
| Plan | An immutable execution plan for one stateRevision |
| Engine | Committed declarations, configuration, origin, bindings, generations, execution phase and transitions |
| Lifetime | Resources, children, tasks, acquisitions and active obligations |
| Catalog | Known immutable Artifacts |
| Registration | The selected Artifact and selection revision |

`PluginContext.dependencies` contains resolved declared requirements. `lifetime`, `events` and `contributions` expose separate capabilities. Dependency aliases therefore do not compete with framework operations for property names.

For example, a plugin declaring `requires: { storage: STORAGE }` receives the bound service at `context.dependencies.storage`. Its setup can read the installation identity from `context.metadata` and write logs through `context.logger`.

Required Services determine the assembly topology. `optional(service)` resolves to `undefined` when absent. Provider changes rebuild affected consumers, keeping references stable within a generation. ExtensionPoints admit multiple contributions with owner-qualified keys; consumers own ordering and selection policy.

A Group organizes declarations and bulk removal. A Lifetime organizes runtime resource ownership. They answer different questions.

Host and Platform diagnostics are derived views. Engine owns `stateRevision`; notification counts, progress changes and task counts do not introduce another version of committed state.
