# Reactive state and observation

`@dougongjs/reactive` has no external dependencies and does not depend on Host. `signal` creates a writable `Signal`, `computed` produces a lazy `ReadonlySignal`, and `batch` coalesces notifications. Read with `get()`; `subscribe(listener)` notifies changes without immediate replay. Subscriptions implement standard `Disposable`.

```ts
import { bridge, computed, observe, signal } from "@dougongjs/reactive";

const query = signal("");
const readableFromAnotherBundle = obtainReadable();
const local = bridge(lifetime, readableFromAnotherBundle);
const title = computed(() => `${query.get()}: ${local.get()}`);

observe(lifetime, title, (value, generation) => {
  generation.spawn((signal) => render(value, signal));
});
```

A computed collector tracks nodes from its own module copy. For another bundle, another copy of the package or another implementation, use the `Readable<T>` protocol and explicitly enter the local graph with `bridge(owner, source)`. `BridgeOwner` only needs `defer`. The caller's Lifetime owns the subscription; no cross-copy global collector exists.

Bridge rereads after subscribing to close the attachment window. On owner shutdown it unsubscribes, invalidates local dependants and clears the retained value. Terminal get and subscribe calls reject; do not retain a bridge beyond its owner's lifetime.

`observe(owner, source, observer)` creates a child owner for each source value. Replacement fully disposes the previous child before creating another; changes arriving during a transition coalesce to the latest value. The returned `AsyncDisposable` supports early termination.

Public types: `Readable`, `Signal`, `ReadonlySignal`, `Disposable`, `AsyncDisposable`, `BridgeOwner`, `ObservationOwner`, `ObservationTask`, `Observer`. `ObservationOwner` describes `defer`, `child`, `spawn` and standard disposal structurally. Compatible owners need not inherit framework classes.

Observers register resources synchronously. Use `generation.spawn` for asynchronous work. The observation task's owner reports failures; a failed old-generation exit never silently starts a replacement.
