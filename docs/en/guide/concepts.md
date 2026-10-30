# Core concepts

Each fact has one owner. Other objects hold references or expose read-only projections.

| Concept | Owned fact |
| --- | --- |
| Service | One capability protocol under a stable identity |
| ExtensionPoint | The protocol of an open collection of contributions |
| Event | The payload protocol of a synchronous broadcast |
| Plugin | Configuration schema, requirements, provisions and setup |
| Installation | Stable installation ID, group, committed configuration and origin |
| Instance | Services and Lifetime from one setup execution |
| ChangeSet | Declaration intent awaiting planning |
| Plan | An immutable execution plan for one stateRevision |
| Engine | Execution phase, committed state, generations and transitions |
| Lifetime | Resources, children, tasks, acquisitions and active obligations |
| Catalog | Known immutable Artifacts |
| Registration | The selected Artifact and selection revision |

`PluginContext.deps` contains resolved declared requirements. `lifetime`, `events` and `contributions` expose separate capabilities. Dependency aliases therefore do not compete with framework operations for property names.

Required Services determine the assembly topology. `optional(service)` resolves to `undefined` when absent. Provider changes rebuild affected consumers, keeping references stable within a generation. ExtensionPoints admit multiple contributions with owner-qualified keys; consumers own ordering and selection policy.

A Group organizes declarations and bulk removal. A Lifetime organizes runtime resource ownership. They answer different questions.

Host and Platform diagnostics are derived views. Engine owns `stateRevision`; notification counts, progress changes and task counts do not introduce another version of committed state.
