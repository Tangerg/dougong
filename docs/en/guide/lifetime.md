# Lifetime and resources

Lifetimes compose into a resource tree. Each Instance creates a root; plugins create child owners through `child(label)`. The root view `context.lifetime` registers resources and tasks; only the Engine can stop the Instance. To end a group of operations early, retain the `ChildLifetime` returned by `child(label)`.

Create a resource domain with `createResourceAuthority()` at the application assembly boundary and pass it through the required `HostOptions.resourceAuthority` to every Host in that domain. Independently bundled copies of Core must receive the same authority object. This structural protocol does not depend on a Core copy's class identity, and Core does not select an implicit default domain.

```ts
import { createHost, createResourceAuthority } from "dougong";

const resourceAuthority = createResourceAuthority();
const applicationHost = createHost({ resourceAuthority, name: "application" });
const deliveryHost = createHost({ resourceAuthority, name: "delivery" });
```

ResourceAuthority arbitrates resource identity reservations and control handle provenance. Lifetime still owns actual tasks, resource release, and settlement. Sharing an authority does not permit multiple Lifetime owners: it gives Hosts and Core copies one place to reject competing adoption. Do not create a separate authority for each Host that shares resources. Different authorities declare independent domains and cannot inspect each other's raw objects; pass access across domains while leaving release with the original owner.

Host captures each authority method once with its original receiver. `claim`, `markControlHandle`, and returned claim-release callbacks must complete synchronously. A failed claim release retains a failed Lifetime obligation and quarantines the Host, even if the resource disposer already succeeded; neither operation is retried. If disposal-method capture and reservation rollback both fail, both errors remain in the retained failure. Task control registration completes before user work is scheduled, so failed registration cannot start unowned work.

| Primitive | Guarantee |
| --- | --- |
| `use(resource)` | Captures the standard disposer and returns the resource after registration |
| `defer(cleanup)` | Registers final cleanup and returns an early-disposal handle |
| `child(label)` | Creates a child owned by the parent tree |
| `spawn(task)` | Starts cancellable background work; `result` fulfills with a frozen `{ value }` receipt |
| `acquire(factory)` | Reserves ownership before creation; resolves to a frozen `{ resource }` receipt |
| `interrupt(interruptWork)` | Registers an interruption required before draining work |
| `signal` | Cooperative cancellation |
| `child[Symbol.asyncDispose]()` | Closes the child subtree you created and joins its single shutdown |

A child Lifetime belongs to the parent that created it. Tasks, `defer`, `interrupt`, Event listeners, Contributions, and contribution view subscriptions with a Lifetime owner also return handles that control their original registration. Within one resource domain, `use` and `acquire` reject these handles regardless of which Lifetime or Core copy is targeted, including after the handle completes. Control handle provenance outlives the original operation. Call the handle's standard disposal method directly to end the original operation or unregister it without creating another release obligation.

Within one resource domain, an external resource object can also have only one Lifetime owner. Repeated `use`, competing `acquire` calls, and registration reentered through a disposal-method getter are rejected. Pending, timed-out, or failed cleanup keeps its original obligation; the same object can be adopted again only after the actual release succeeds. Give shared resources one explicit Lifetime and pass access through Service parameters.

`Symbol.dispose` must finish synchronously; use `Symbol.asyncDispose` for asynchronous release. A synchronous callback returning a supported Promise or thenable is rejected, and failed release remains owned by the original Lifetime. Core and Reactive share one asynchronous result protocol. A prototype chain containing this realm's `Promise.prototype` selects intrinsic `then`, which validates the native brand and observes actual settlement, including local subclasses; an own `then` cannot replace it. Other objects use one captured callable `then` with its original receiver and standard recursive thenable resolution. `Symbol.toStringTag` describes presentation only: it neither selects a protocol nor has its getter evaluated.

Protocol selection does not modify the input. Inheriting this realm's `Promise.prototype` selects the intrinsic protocol; a forged object without native internal state cannot switch to the structural protocol. Cyclic prototype chains fail explicitly. If intrinsic observation fails through `constructor` or `Symbol.species`, the original error propagates once without trying another protocol. Observing the original Promise's rejection cannot be guaranteed in that case, and the resource owner retains its failed release obligation. Promises from another realm use their public `then`; hiding or breaking that method falls outside the guarantee. To deliver a value with a mutable or executable `then` across realms, place it in an ordinary data container in the source realm before delivering its Promise. Replacing a local Promise's entire prototype chain also removes the intrinsic-protocol guarantee.

Shutdown seals entry, withdraws publications and broadcasts cancellation, starts all interruptions and waits for them together, joins active work and acquisitions, then releases resources in reverse order. Use `interrupt` to break a blocking read and `defer` for final destruction that must wait for tasks to finish.

Closing entry and cancelling admitted work are distinct stages. Engine seals affected Instances before waiting for consumers in dependency order, so a provider may be sealed while its signal is still active. New `acquire` calls are rejected, but an acquisition already registered can complete and deliver its resource for a consumer's final flush. Only genuine cancellation of the original signal reclaims a late resource and rejects with that signal's original reason. Independent factory failures still propagate as errors.

Normal destructive changes and explicit child disposal reject while an affected foreground borrow is active. Quarantine has already revoked availability: once its consumers have actually exited, Engine starts that generation's shutdown and cancels its admitted foreground work. Interruptions can unblock that work, but final resource release still waits for it to settle. Such a generation is `disposing` while its borrow drains; a provider awaiting consumers stays `sealed` with its original signal active.

```ts
const { resource: connection } = await lifetime.acquire(async (signal) => openConnection(signal));
lifetime.interrupt(() => connection.interruptRead());
lifetime.spawn((signal) => connection.readUntilClosed(signal));
```

The factory result is resolved once at the protocol boundary above. After adoption, `receipt.resource` is the exact object whose disposer the Lifetime captured. Returning it inside a receipt prevents another Promise resolution from treating the resource as a different thenable. Callers migrating from a raw result destructure `resource` as above.

The type parameter of `acquire<Result>` describes the factory's return type, and `Awaited<Result>` must satisfy `Resource`. Prefer inference for ordinary calls. An explicit type argument for an asynchronous factory includes `Promise`, such as `acquire<Promise<Connection>>`. Generic forwarding must also prove that the final result is a resource: `Result extends Resource` alone cannot exclude a disposable `Promise<number>` whose fulfillment is not a resource.

`Task<T>.result` returns `Promise<ResolvedValue<T>>`, where `T` is the fulfilled data type. For a callback result type `Result`, `host.use` and `ContributionView.use` return `Promise<ResolvedValue<Awaited<Result>>>`; nested Promise types are unwrapped before delivery. `ResolvedValue<T>` has only a readonly `value`, and successful receipts are frozen. Obtain the result with `const { value } = await task.result` or `const { value } = await host.use(token, callback)`. Failures still reject with their original reason. The receipt preserves the fulfilled result's identity without resolving its `then` again, creating another resource owner or extending a borrow. Tasks and acquisitions still start asynchronously after their obligations are registered; foreground borrow callbacks still enter synchronously.

Cleanup failure cannot claim a clean exit. Lifetime retains failed releases and unfinished work, and Host `unresolved` projects retained execution generations. A child that has not exited prevents release of parent resources it may still use. Likewise, an unfinished consumer retains its transitive providers while independent branches continue safe cleanup. A foreground borrow also cannot be forcibly destroyed.

A cleanup failure through an early child or defer handle also quarantines the entire Host. Lifetime reports the release failure; Engine withdraws availability before capturing diagnostics and cleaning up independently safe branches. The direct caller receives the original release failure, while the Host error reporter receives the quarantine outcome. An Error getter cannot borrow a Service while its diagnostic is captured. Candidates being prepared or restored belong to the same shutdown and cannot commit after the fault.

A configured `shutdownTimeoutMilliseconds` must be positive and at most 2,147,483,647 ms (the native timer limit); omit it to wait without a deadline. A timeout ends waiting without proving the underlying work stopped. Engine continues the same retirement as borrowers finish and consumers actually exit successfully, including first releases that could not begin before the timeout. Failed cleanup is never automatically retried. Quarantine is terminal for the whole Host; late completion updates diagnostics without resuming service or advancing `stateRevision`. AbortSignal cannot forcibly terminate arbitrary JavaScript; that requires a real execution boundary. See [Application handling after quarantine](./transactions.md#quarantine) for incident handling and replacement preconditions.

A deferred foreground drain or an already expired consumer receipt does not hold the initial quarantine failure open. Unfinished ownership stays visible in diagnostics. If that continuing retirement later fails, the new failure updates the bounded diagnostics and reaches the Host error reporter without another health transition. A failure already returned through its owning shutdown receipt is not reported a second time.

A child Lifetime's shutdown deadline remains independent. Its expiry quarantines the entire Host even while the root is shutting down; cleanup finishing before the root deadline cannot make a stop or update succeed. Lifetime still joins the child's actual cleanup work, while Engine uses the failure's origin to maintain the single terminal quarantine. A timed-out child receipt cannot authorize releasing parent resources or Service providers early.

Lifetime `unresolved` distinguishes registered releases from shutdown waiting by `kind`. The `cleanup`, `interrupt`, and `publication` branches carry the original registration's numeric `id`. The `shutdown` branch describes the Lifetime's own waiting deadline and has no registration `id`. Narrow by `kind` before reading a registration identity.

Only the native AbortSignal state establishes cancellation. Dispatching an event named `abort` does not cancel a child scope or task and does not consume its subscription to genuine cancellation. The Lifetime propagates cancellation directly to its owned tasks and descendants. A public event listener that stops propagation cannot prevent that structural shutdown.

The `onAbort(signal, callback)` primitive from `dougong/advanced` requires a synchronous callback. A supported Promise or thenable result is observed before the protocol violation is rejected with TypeError. If the signal is already aborted, callback errors escape directly from `onAbort`; on later cancellation, they follow the native AbortSignal event error channel. Register interruptions or cleanup that must be awaited through `lifetime.interrupt` or `lifetime.defer`.

After successful shutdown, each Lifetime exposes its own already-aborted signal. A retained child handle no longer holds the original controller or its listeners, and another retired scope cannot notify listeners on this signal.

Each independent disposal creates its own cancellation reason; one tree-wide cancellation propagates the same reason to descendants. An operation should retain the signal it received at entry and use that signal to classify its cancellation. `spawn` and `acquire` already pass the corresponding signal to their callbacks. After successful disposal, a retained handle exposes an aborted signal detached from the old resource graph; it cannot reconstruct the reason identity of an earlier operation.

Tasks own background error reporting. Failures of `host.use` and contribution `use` propagate to their caller; do not rethrow the same outcome as another background failure. Task completion and borrow release follow settlement of the Promise returned to the caller. Shutdown registers its own join before exposing a task or acquisition result: decorating that Promise cannot release ownership. Lifetime task counts, interrupt counts, foreground counts and unresolved obligations are read-only projections of resource facts. Event listeners, snapshot subscribers and error callbacks receive no internal owner as their JavaScript `this`; use the explicit capabilities supplied to the plugin.

The `installations` collection from `host.diagnostics.get()` projects only committed Installations. A `running` row contains both the `generation` and `lifetime` of the same Instance. Both fields are `undefined` for `stopped` and `quarantined` rows. A `changing` row can retain both fields or have neither. The `pending` and `removed` states belong to Installation handles and do not appear in this committed collection.

`isCancellationReason(signal, error)` requires native cancellation and the same cancellation reason: either the error is `signal.reason` itself, or it is an Error named `AbortError` whose own data property `cause` is that reason. The latter covers interfaces such as Node's asynchronous timers that preserve the reason in a wrapper. The name alone cannot establish causality; a later cancellation never suppresses an independent failure. Custom adapters should preserve the actual cancellation reason instead of inferring its source from a name. Independent failures need no defensive wrapper.

For noncancellable external operations, the example `acquireForLifetime` separates a generation's wait from completion of the underlying operation: the generation can stop waiting while a longer-lived operations owner still joins and reclaims late results. This application policy composes `spawn`, `defer` and AbortSignal without hiding resource obligations from the kernel.

Each handoff shares one release attempt for its acquired resource. Even if a custom destination `defer` saves the cleanup callback before throwing, source reclamation and destination retirement only request or join that same release; failure retains the original obligation without retrying it. After destination registration returns successfully, the source withdraws its reclamation reservation, so later operations-owner retirement cannot release the transferred resource early. Successful release detaches the resource and disposer even when the destination retains its cleanup callback.

The example reserves reclamation with the operations owner before starting external work. Ownership transfers when the generation accepts the resource. If the operations owner retires before transfer, or the generation has retired or refuses registration, the operations owner reclaims it. A factory rejection is a task failure; failure to reclaim a returned resource remains a cleanup obligation and prevents a successful Host shutdown.

Publication withdrawal errors from a child propagate with their original cause. The child remains accountable for the failed release even if the publication detached before throwing; parent diagnostics expose a bounded error snapshot.
