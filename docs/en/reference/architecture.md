# Architecture

Dougong publishes three packages. `dougong` is the kernel. `@dougongjs/platform` is a delivery layer depending on the kernel. `@dougongjs/reactive` is independent and composes through structural protocols. Root-level `examples` is a downstream application and `tooling` owns building, verification and release.

| Directory | Responsibility |
| --- | --- |
| `packages/dougong/src/contracts` | Identity, protocols, statuses, error and logging contracts |
| `packages/dougong/src/internal` | Shared low-level record, queue and protocol primitives |
| `packages/dougong/src/observation` | Stable snapshots and publication |
| `packages/dougong/src/lifetime` | Resource ownership and shutdown |
| `packages/dougong/src/events` | Synchronous event publication |
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


## Ownership and direction

Engine owns committed state and stateRevision. Installation handles, Host, Plan and diagnostics are bounded protocols or projections, without competing state machines. PlanAuthority owns execution authority, Lifetime owns resource obligations, Registration owns selection intent, and Installation origin owns execution provenance.

Lower responsibilities do not import higher ones. Contracts do not import execution. Lifetime imports neither events nor contributions; both compose Lifetime publication and borrowing primitives. Inspection projects stable diagnostics; reusable observation belongs to its own lower-level directory.

Cross-package imports use only declared exports. `dougong/advanced` is a formal entrypoint for downstream composition primitives, with no mutable core registry or private control port. Physical directories follow these responsibilities. Unknown responsibility directories fail the guard and require an explicit design decision.

## Guarantees

One commit atomically publishes services, listeners, contributions and origin. External effects caused by candidate execution are outside automatic rollback guarantees. Failed shutdown retains obligations and quarantines execution instead of clearing ownership collections and claiming success.

Agents and humans share structured PlanReport, HostSnapshot, error details and apply. Reports do not copy configuration payloads. Agent schemas require an explicit schema exporter rather than guessing from arbitrary TypeScript types.

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
