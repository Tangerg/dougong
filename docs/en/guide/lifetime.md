# Lifetime and resources

Lifetimes compose into a resource tree. Each Instance creates a root; plugins create child owners through `child(label)`. The root view `context.lifetime` registers resources and tasks; only the Engine can stop the Instance. To end a group of operations early, retain the `ChildLifetime` returned by `child(label)`.

| Primitive | Guarantee |
| --- | --- |
| `use(resource)` | Captures the standard disposer and returns the resource after registration |
| `defer(cleanup)` | Registers final cleanup and returns an early-disposal handle |
| `child(label)` | Creates a child owned by the parent tree |
| `spawn(task)` | Starts cancellable background work with a Task `result` |
| `acquire(factory)` | Reserves ownership before creation; resolves to a frozen `{ resource }` receipt |
| `interrupt(interruptWork)` | Registers an interruption required before draining work |
| `signal` | Cooperative cancellation |
| `child[Symbol.asyncDispose]()` | Closes the child subtree you created and joins its single shutdown |

A child Lifetime belongs to the parent that created it. Within one loaded copy of Core, `use` and `acquire` reject an existing child handle. Across separately bundled copies, keep the child with its original parent. Its handle can still end the subtree early.

Shutdown seals entry, withdraws publications and broadcasts cancellation, starts all interruptions and waits for them together, joins active work and acquisitions, then releases resources in reverse order. Use `interrupt` to break a blocking read and `defer` for final destruction that must wait for tasks to finish.

```ts
const { resource: connection } = await lifetime.acquire(async (signal) => openConnection(signal));
lifetime.interrupt(() => connection.interruptRead());
lifetime.spawn((signal) => connection.readUntilClosed(signal));
```

The factory result follows normal Promise resolution. After adoption, `receipt.resource` is the exact object whose disposer the Lifetime captured. Returning it inside a receipt prevents another Promise resolution from treating the resource as a different thenable. Callers migrating from a raw result destructure `resource` as above.

Cleanup failure cannot claim a clean exit. Lifetime retains failed releases and unfinished work, and Host `unresolved` projects retained execution generations. A child that has not exited prevents release of parent resources it may still use. Likewise, an unfinished consumer retains its transitive providers while independent branches continue safe cleanup. A foreground borrow also cannot be forcibly destroyed.

A configured `shutdownTimeoutMilliseconds` must be positive and at most 2,147,483,647 ms (the native timer limit); omit it to wait without a deadline. A timeout ends waiting without proving the underlying work stopped. Shutdown already started may finish later, but failed cleanup is not automatically retried. Quarantine is terminal for the whole Host; late completion updates diagnostics without resuming service. AbortSignal cannot forcibly terminate arbitrary JavaScript; that requires a real execution boundary. See [Application handling after quarantine](./transactions.md#quarantine) for incident handling and replacement preconditions.

Only the native AbortSignal state establishes cancellation. Dispatching an event named `abort` does not cancel a child scope or task and does not consume its subscription to genuine cancellation. The Lifetime propagates cancellation directly to its owned tasks and descendants. A public event listener that stops propagation cannot prevent that structural shutdown.

After successful shutdown, each Lifetime exposes its own already-aborted signal. A retained child handle no longer holds the original controller or its listeners, and another retired scope cannot notify listeners on this signal.

Tasks own background error reporting. Failures of `host.use` and contribution `use` propagate to their caller; do not rethrow the same outcome as another background failure. Task completion and borrow release follow settlement of the Promise returned to the caller. Shutdown registers its own join before exposing a task or acquisition result: decorating that Promise cannot release ownership. Lifetime task counts, interrupt counts, foreground counts and unresolved obligations are read-only projections of resource facts. Event listeners, snapshot subscribers and error callbacks receive no internal owner as their JavaScript `this`; use the explicit capabilities supplied to the plugin.

For noncancellable external operations, the example `acquireForLifetime` composes two owners: a generation can stop waiting while a longer-lived operations owner still joins and reclaims late results. This application policy composes `spawn`, `defer` and AbortSignal without hiding resource obligations from the kernel.

The example reserves reclamation with the operations owner before starting external work. Ownership transfers when the generation accepts the resource. If the operations owner retires before transfer, or the generation has retired or refuses registration, the operations owner reclaims it. A factory rejection is a task failure; failure to reclaim a returned resource remains a cleanup obligation and prevents a successful Host shutdown.

Publication withdrawal errors from a child propagate with their original cause. The child remains accountable for the failed release even if the publication detached before throwing; parent diagnostics expose a bounded error snapshot.
