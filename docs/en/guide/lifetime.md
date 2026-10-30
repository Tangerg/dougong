# Lifetime and resources

Lifetimes compose into a resource tree. Each Instance creates a root; plugins create child owners through `child(label)`. Public handles use standard disposal protocols, so third-party resources need no additional custom method.

| Primitive | Guarantee |
| --- | --- |
| `use(resource)` | Captures the standard disposer and returns the resource after registration |
| `defer(fn)` | Registers final cleanup and returns an early-disposal handle |
| `child(label)` | Creates a child owned by the parent tree |
| `spawn(task)` | Starts cancellable background work with a Task `result` |
| `acquire(factory)` | Registers the obligation before creation; late resources remain owned |
| `interrupt(fn)` | Registers an interruption required before draining work |
| `signal` | Cooperative cancellation |
| `[Symbol.asyncDispose]()` | Joins the single shutdown execution |

Shutdown seals entry, withdraws publications and broadcasts cancellation, runs interruptions, joins active work and acquisitions, then releases resources in reverse order. Use `interrupt` to break a blocking read and `defer` for final destruction that must wait for tasks to finish.

```ts
const connection = await lifetime.acquire(async (signal) => openConnection(signal));
lifetime.interrupt(() => connection.interruptRead());
lifetime.spawn((signal) => connection.readUntilClosed(signal));
```

Cleanup failure cannot claim a clean exit. Failed releases and unfinished tasks or acquisitions remain in `unresolved`; Host becomes quarantined and cannot resume serving. A timeout ends waiting but cannot prove underlying work stopped. AbortSignal cannot terminate arbitrary JavaScript in the same thread; hard isolation requires a separately designed executor.

Tasks own background error reporting. Failures of `host.use` and contribution `use` propagate to their caller; do not rethrow the same outcome as another background failure. Lifetime task counts, foreground counts and unresolved obligations are read-only projections of resource facts.

For noncancellable external operations, the example `acquireForLifetime` composes two owners: a generation can stop waiting while a longer-lived operations owner still joins and reclaims late results. This application policy composes `spawn`, `defer` and AbortSignal without hiding resource obligations from the kernel.
