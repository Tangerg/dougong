import type { Disposable } from "@dougong/reactive";

export type EventListener<T> = (payload: T) => unknown;

export class EventHub {
  readonly #listeners = new Map<string, Set<EventListener<unknown>>>();

  on<T>(eventId: string, listener: EventListener<T>): Disposable {
    const listeners = this.#listeners.get(eventId) ?? new Set();
    this.#listeners.set(eventId, listeners);
    listeners.add(listener as EventListener<unknown>);

    let active = true;
    return {
      dispose: () => {
        if (!active) return;
        active = false;
        listeners.delete(listener as EventListener<unknown>);
        if (!listeners.size) this.#listeners.delete(eventId);
      },
    };
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
