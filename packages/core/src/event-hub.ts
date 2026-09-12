// Events are transient facts: no history, no replay, no ordering guarantee
// between listeners. Nothing here stores a payload, which is what keeps an Event
// from quietly becoming a state container.
//
// A listener is staged when `on()` is called during `setup()` and added to the
// hub only when its Lifetime publishes, so an Instance cannot receive an Event
// before it finishes starting.

import { disposeSymbol, type Disposable, type Publication, type StagedResource } from "./resource";

export type EventListener<T> = (payload: T) => unknown;

interface ListenerSlot<T> {
  listener: EventListener<T> | undefined;
}

type ListenerRegistrationState<T> =
  | {
      phase: "staged" | "published";
      readonly hub: EventHub;
      readonly slot: ListenerSlot<T>;
      readonly release: (publication: Publication) => void;
    }
  | { readonly phase: "removed" };

class ListenerHandle implements Disposable {
  #registration: ListenerRegistration<unknown> | undefined;

  constructor(registration: ListenerRegistration<unknown>) {
    this.#registration = registration;
    Object.freeze(this);
  }

  dispose() {
    const registration = this.#registration;
    this.#registration = undefined;
    registration?.dispose();
  }

  [disposeSymbol]() {
    this.dispose();
  }
}

class ListenerRegistration<T> implements StagedResource<Disposable> {
  #state: ListenerRegistrationState<T>;
  readonly #eventId: string;
  readonly handle: Disposable;

  constructor(
    hub: EventHub,
    eventId: string,
    listener: EventListener<T>,
    release: (publication: Publication) => void,
  ) {
    this.#eventId = eventId;
    this.#state = { phase: "staged", hub, slot: { listener }, release };
    this.handle = new ListenerHandle(this as ListenerRegistration<unknown>);
  }

  publish() {
    const state = this.#state;
    if (state.phase !== "staged") return;
    state.hub.add(this.#eventId, state.slot);
    state.phase = "published";
  }

  dispose() {
    const state = this.#state;
    if (state.phase === "removed") return;
    this.#state = { phase: "removed" };
    state.slot.listener = undefined;
    try {
      if (state.phase === "published") state.hub.delete(this.#eventId, state.slot);
    } finally {
      state.release(this);
    }
  }

  [disposeSymbol]() {
    this.dispose();
  }
}

export class EventHub {
  readonly #listeners = new Map<string, Set<ListenerSlot<unknown>>>();

  stage<T>(
    eventId: string,
    listener: EventListener<T>,
    release: (publication: Publication) => void,
  ): StagedResource<Disposable> {
    if (typeof listener !== "function") throw new TypeError("Event listener must be a function");
    return new ListenerRegistration(this, eventId, listener, release);
  }

  add<T>(eventId: string, slot: ListenerSlot<T>) {
    const listeners = this.#listeners.get(eventId) ?? new Set();
    this.#listeners.set(eventId, listeners);
    listeners.add(slot as ListenerSlot<unknown>);
  }

  delete<T>(eventId: string, slot: ListenerSlot<T>) {
    const listeners = this.#listeners.get(eventId);
    if (!listeners) return;
    listeners.delete(slot as ListenerSlot<unknown>);
    if (!listeners.size) this.#listeners.delete(eventId);
  }

  /**
   * Every still-subscribed listener runs, then failures are aggregated. Three details, all
   * deliberate:
   *
   * - the listener set is copied first; a new subscription does not join this
   *   emission. A disposed slot is skipped if its callback has not started;
   * - each call is wrapped in a resolved promise, so a listener that throws
   *   synchronously is collected like one that rejects;
   * - `allSettled`, so one broken listener cannot stop the others from being
   *   told. The emitter still learns about it — every error comes back.
   */
  async emit<T>(eventId: string, payload: T) {
    const listeners = [...(this.#listeners.get(eventId) ?? [])];
    const results = await Promise.allSettled(
      listeners.map((slot) => Promise.resolve().then(() => slot.listener?.(payload))),
    );
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);

    if (errors.length) {
      throw new AggregateError(errors, `Event '${eventId}' listeners failed`);
    }
  }
}
