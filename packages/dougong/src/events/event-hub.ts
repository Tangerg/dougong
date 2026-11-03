import { normalizeContract, type ContractIdentity, type Event } from "../contracts/contracts.js";
import { DougongError, eventBeforeCommitCode, lifetimeDisposedCode } from "../contracts/errors.js";
import type { Lifetime, LifetimeOwnership } from "../lifetime/lifetime.js";
import { disposeSymbol, type Disposable, type Publication } from "../contracts/resource.js";

export type EventListener<T> = (payload: T) => unknown;
export type EventArguments<T> = [T] extends [void] ? [payload?: T] : [payload: T];

export interface EventOperations {
  on<T>(token: Event<T>, listener: EventListener<T>, options?: LifetimeOwnership): Disposable;
  emit<T>(token: Event<T>, ...payload: EventArguments<T>): Promise<void>;
}

interface ListenerBinding<T> {
  readonly hub: EventHub;
  readonly listener: EventListener<T>;
  readonly owner: Lifetime;
  readonly detach: () => void;
}

class ListenerRegistration<T> implements Publication {
  readonly #eventId: string;
  #binding: ListenerBinding<T> | undefined;
  readonly handle: Disposable;

  constructor(
    hub: EventHub,
    eventId: string,
    listener: EventListener<T>,
    owner: Lifetime,
    detach: () => void,
  ) {
    this.#eventId = eventId;
    this.#binding = { hub, listener, owner, detach };
    this.handle = Object.freeze({ [disposeSymbol]: () => this[disposeSymbol]() });
  }

  publish() {
    const binding = this.#binding;
    if (!binding) return;
    binding.hub.add(this.#eventId, this);
  }

  invoke(payload: T): Promise<unknown> {
    const binding = this.#binding;
    if (!binding?.owner.acceptsWork) return Promise.resolve();
    const { owner, listener } = binding;
    return owner.borrow(() => listener(payload));
  }

  [disposeSymbol]() {
    const binding = this.#binding;
    if (!binding) return;
    this.#binding = undefined;
    binding.hub.delete(this.#eventId, this);
    binding.detach();
  }
}

class EventScope implements EventOperations {
  #binding:
    | {
        readonly hub: EventHub;
        readonly owner: Lifetime;
        readonly remember: (token: ContractIdentity) => void;
      }
    | undefined;

  constructor(hub: EventHub, owner: Lifetime, remember: (token: ContractIdentity) => void) {
    this.#binding = { hub, owner, remember };
    owner.defer(() => {
      this.#binding = undefined;
    });
    Object.freeze(this);
  }

  on<T>(token: Event<T>, listener: EventListener<T>, options?: LifetimeOwnership) {
    const binding = this.#requireBinding();
    if (typeof listener !== "function") throw new TypeError("Event listener must be a function");
    const identity = normalizeContract(token, "event");
    const owner = binding.owner.resolveOwner(options);
    binding.remember(identity);
    return binding.hub.stage(identity.id, listener, owner);
  }

  async emit<T>(token: Event<T>, ...payload: EventArguments<T>) {
    const binding = this.#requireBinding();
    if (!binding.owner.published) {
      throw new DougongError(
        eventBeforeCommitCode,
        "Candidate setup cannot emit into the committed event graph",
      );
    }
    const identity = normalizeContract(token, "event");
    this.#requireBinding();
    binding.remember(identity);
    await binding.hub.emit(identity.id, payload[0] as T);
  }

  #requireBinding() {
    const binding = this.#binding;
    if (!binding || !binding.owner.acceptsWork) {
      throw new DougongError(lifetimeDisposedCode, "Event scope is closed");
    }
    return binding;
  }
}

export class EventHub {
  readonly #listeners = new Map<string, Set<ListenerRegistration<unknown>>>();

  scope(owner: Lifetime, remember: (token: ContractIdentity) => void): EventOperations {
    return new EventScope(this, owner, remember);
  }

  stage<T>(eventId: string, listener: EventListener<T>, owner: Lifetime): Disposable {
    return owner.stage((detach) => new ListenerRegistration(this, eventId, listener, owner, detach))
      .handle;
  }

  add<T>(eventId: string, registration: ListenerRegistration<T>) {
    const listeners = this.#listeners.get(eventId) ?? new Set();
    listeners.add(registration as ListenerRegistration<unknown>);
    this.#listeners.set(eventId, listeners);
  }

  delete<T>(eventId: string, registration: ListenerRegistration<T>) {
    const listeners = this.#listeners.get(eventId);
    if (!listeners) return;
    listeners.delete(registration as ListenerRegistration<unknown>);
    if (!listeners.size) this.#listeners.delete(eventId);
  }

  async emit<T>(eventId: string, payload: T): Promise<void> {
    const listeners = [...(this.#listeners.get(eventId) ?? [])];
    const results = await Promise.allSettled(
      listeners.map((listener) => {
        try {
          return listener.invoke(payload);
        } catch (error) {
          return Promise.reject(error);
        }
      }),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) throw new AggregateError(errors, `Event '${eventId}' listeners failed`);
  }
}
