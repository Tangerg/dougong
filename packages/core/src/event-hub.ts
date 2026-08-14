import type { Disposable, Publication, StagedResource } from "./resource";

export type EventListener<T> = (payload: T) => unknown;

type ListenerRegistrationState<T> =
  | {
      phase: "staged" | "published";
      readonly hub: EventHub;
      readonly listener: EventListener<T>;
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

  [Symbol.dispose]() {
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
    this.#state = { phase: "staged", hub, listener, release };
    this.handle = new ListenerHandle(this as ListenerRegistration<unknown>);
  }

  publish() {
    const state = this.#state;
    if (state.phase !== "staged") return;
    state.hub.add(this.#eventId, state.listener);
    state.phase = "published";
  }

  dispose() {
    const state = this.#state;
    if (state.phase === "removed") return;
    this.#state = { phase: "removed" };
    try {
      if (state.phase === "published") state.hub.delete(this.#eventId, state.listener);
    } finally {
      state.release(this);
    }
  }

  [Symbol.dispose]() {
    this.dispose();
  }
}

export class EventHub {
  readonly #listeners = new Map<string, Set<EventListener<unknown>>>();

  stage<T>(
    eventId: string,
    listener: EventListener<T>,
    release: (publication: Publication) => void,
  ): StagedResource<Disposable> {
    if (typeof listener !== "function") throw new TypeError("Event listener must be a function");
    return new ListenerRegistration(this, eventId, listener, release);
  }

  add<T>(eventId: string, listener: EventListener<T>) {
    const listeners = this.#listeners.get(eventId) ?? new Set();
    this.#listeners.set(eventId, listeners);
    listeners.add(listener as EventListener<unknown>);
  }

  delete<T>(eventId: string, listener: EventListener<T>) {
    const listeners = this.#listeners.get(eventId);
    if (!listeners) return;
    listeners.delete(listener as EventListener<unknown>);
    if (!listeners.size) this.#listeners.delete(eventId);
  }

  async emit<T>(eventId: string, payload: T) {
    const listeners = [...(this.#listeners.get(eventId) ?? [])] as EventListener<T>[];
    const results = await Promise.allSettled(
      listeners.map((listener) => Promise.resolve().then(() => listener(payload))),
    );
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);

    if (errors.length) {
      throw new AggregateError(errors, `Event '${eventId}' listeners failed`);
    }
  }
}
