// The `dougong` facade. Re-exports only — no statement in this file may do
// anything else, and `check-layers.mjs` fails the build if one does.
//
// Its whole purpose is one install and one import specifier for application code.
// A consumer who wants tighter dependencies imports the scoped packages directly;
// nothing here is unavailable there.
//
// Core and Platform are re-exported wholesale because their own barrels are
// already explicit allowlists checked against `dist/index.d.ts`. Reactive is
// listed name by name because it also exports `Disposable` and `AsyncDisposable`,
// which Core exports too — one name must win, and it is Core's, since that is the
// protocol a Lifetime hands out.

export * from "@dougongjs/core";
export * from "@dougongjs/platform";
export {
  batch,
  computed,
  observe,
  signal,
  type ObservationLifetime,
  type ObservationOwner,
  type ObservationTask,
  type Observer,
  type Readable,
  type ReadonlySignal,
  type Signal,
} from "@dougongjs/reactive";
