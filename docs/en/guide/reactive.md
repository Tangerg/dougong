# Reactive state and observation

`@dougongjs/reactive` has no external dependencies and does not depend on Host. `signal` creates a writable `Signal`, `computed` produces a lazy `ReadonlySignal`, and `batch` coalesces notifications. Read with `get()`; `subscribe(listener)` notifies changes without immediate replay. Subscriptions implement standard `Disposable`.

For explicit disposal, import `disposeSymbol` or `asyncDisposeSymbol` from `@dougongjs/reactive`. These keys also work on supported runtimes without native disposal symbols.

Callbacks passed to `batch` and `computed` must finish synchronously. Their public types reject direct Promise or PromiseLike results, including unions with an asynchronous branch; runtime validation still checks dynamic inputs. A rejected async callback may already have produced effects, and the batch cannot revoke its continuation. Promises may remain data, as in `signal(promise)` or `computed(() => ({ pending: promise }))`. Use Lifetime `spawn` to own asynchronous work and join its shutdown.

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

A write marks dependent computed signals stale without evaluating them. Subscribers continue receiving invalidations even when they defer reading the value. A batch delays notification, but eligibility is decided at each write: subscribing to a computed signal after a write, even inside the same batch or from another listener, does not replay that write. A later write in the batch can notify the new subscriber. A shared dependency is checked at most once between writes, so repeated reads of a diamond graph do not rewalk each path. Reading a cyclic computation throws. When an input breaks the cycle, direct reads and subscribers that caught the error can recover.

A computed collector tracks nodes from its own module copy. For another bundle, another copy of the package or another implementation, use the `Readable<T>` protocol and explicitly enter the local graph with `bridge(owner, source)`. `BridgeOwner` only needs `defer`. The caller's Lifetime owns the subscription; no cross-copy global collector exists.

Bridge rereads after subscribing to close the attachment window. On owner shutdown it unsubscribes, invalidates local dependants and clears the retained value. Existing subscribers receive one terminal invalidation, including inside a batch, unless they unsubscribe before delivery. Terminal get and subscribe calls reject; do not retain a bridge beyond its owner's lifetime.

Once attached, a failed source read invalidates the bridge: local reads throw the source error, and a later successful read recovers even if the value equals its last success.

`observe(owner, source, observer)` creates a child owner for each source value. Replacement fully disposes the previous child before creating another; changes arriving during a transition coalesce to the latest value. The returned `AsyncDisposable` joins one registration release across concurrent and repeated calls, including a failed release. If the initial observer closes its owner synchronously, construction fails before the background task starts.

Public types: `Readable`, `Signal`, `ReadonlySignal`, `Disposable`, `AsyncDisposable`, `BridgeOwner`, `ObservationOwner`, `ObservationTask`, `Observer`. `ObservationOwner` needs `defer`, `child` and `spawn`; the returned child supplies standard async disposal. The parent need not expose a disposer. Compatible owners need not inherit framework classes.

Observation only needs the drain task's completion. `ObservationTask` has no type parameter and exposes `result: PromiseLike<unknown>`; `spawn` accepts a task returning `void | PromiseLike<void>`. An owner with a generic `spawn` or a Task carrying result data still satisfies this narrower protocol. Observation does not interpret that payload. Existing declarations using `ObservationTask<T>` must remove the type argument.

Observers register resources synchronously. Use `generation.spawn` for asynchronous work. The observation task's owner reports failures; a failed old-generation exit never silently starts a replacement.

The adapters capture the accepted source methods and subscription disposer. Observation also captures each child, task and cleanup handle’s disposer when it takes ownership. If a custom owner returns a cancellable task whose `result` is missing or throws, construction fails and rollback invokes that task’s captured disposer. A failed unsubscribe remains a release obligation of the owner: early termination, drain failure and later shutdown cannot turn it into success by running it again.

## Asynchronous result protocol

Synchronous boundary checks and asynchronous release share one result protocol. A prototype chain containing this module's realm's `Promise.prototype` selects the native protocol. Intrinsic `then` validates the brand and observes actual settlement; an own `then` cannot replace it, and an already fulfilled payload is not assimilated again. A `constructor` or `Symbol.species` failure propagates without retrying the public `then`. Child, drain-task and owner-registration disposal all join that outcome before replacement or observation completion.

Other objects use the structural protocol: capture the public `then` once, preserve its receiver and follow standard recursive resolution. `Symbol.toStringTag` has no role in protocol selection, so a structural Promise with a `"Promise"` display tag remains valid.

This narrows the guarantee across realms. An ordinary foreign Promise supplies a conforming public `then`; the package does not infer its internal native brand. Adapt a foreign Promise that hides or changes that protocol in its origin realm first. If its fulfilled payload cannot tolerate another assimilation, box the payload into a plain data receipt in that realm before crossing the boundary.
