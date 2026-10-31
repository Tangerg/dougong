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

A write marks dependent computed signals stale without evaluating them. A batch delays notification, but eligibility is decided at each write: subscribing to a computed signal after a write, even inside the same batch or from another listener, does not replay that write. A later write in the batch can notify the new subscriber.

A computed collector tracks nodes from its own module copy. For another bundle, another copy of the package or another implementation, use the `Readable<T>` protocol and explicitly enter the local graph with `bridge(owner, source)`. `BridgeOwner` only needs `defer`. The caller's Lifetime owns the subscription; no cross-copy global collector exists.

Bridge rereads after subscribing to close the attachment window. On owner shutdown it unsubscribes, invalidates local dependants and clears the retained value. Terminal get and subscribe calls reject; do not retain a bridge beyond its owner's lifetime.

`observe(owner, source, observer)` creates a child owner for each source value. Replacement fully disposes the previous child before creating another; changes arriving during a transition coalesce to the latest value. The returned `AsyncDisposable` supports early termination.

Public types: `Readable`, `Signal`, `ReadonlySignal`, `Disposable`, `AsyncDisposable`, `BridgeOwner`, `ObservationOwner`, `ObservationTask`, `Observer`. `ObservationOwner` needs `defer`, `child` and `spawn`; the returned child supplies standard async disposal. The parent need not expose a disposer. Compatible owners need not inherit framework classes.

Observers register resources synchronously. Use `generation.spawn` for asynchronous work. The observation task's owner reports failures; a failed old-generation exit never silently starts a replacement.

The adapters capture the accepted source methods and subscription disposer. Observation also captures each child, task and cleanup handle’s disposer when it takes ownership. If a custom owner returns a cancellable task whose `result` is missing or throws, construction fails and rollback invokes that task’s captured disposer. A failed unsubscribe remains a release obligation of the owner: early termination, drain failure and later shutdown cannot turn it into success by running it again.
