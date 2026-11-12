import { disposeSymbol, type HostSnapshot, type SnapshotView } from "dougong";
import { assertSynchronous } from "dougong/advanced";

const invalidSubscriptionMessage = "Host diagnostics subscribe() must return a Disposable";

type HostObservationState =
  | { readonly phase: "attaching"; readonly synchronize: () => void }
  | {
      readonly phase: "attached";
      readonly synchronize: () => void;
      readonly withdraw: () => void;
    }
  | { readonly phase: "closed" };

export class HostObservation {
  #state: HostObservationState;

  constructor(source: SnapshotView<HostSnapshot>, synchronize: () => void) {
    this.#state = { phase: "attaching", synchronize };
    try {
      const subscription = source.subscribe(this.synchronize);
      const dispose = subscription?.[disposeSymbol];
      if (typeof dispose !== "function") {
        assertSynchronous(subscription, invalidSubscriptionMessage);
        throw new TypeError(invalidSubscriptionMessage);
      }
      this.#state = {
        phase: "attached",
        synchronize,
        withdraw: () =>
          assertSynchronous(
            Reflect.apply(dispose, subscription, []),
            "Host diagnostics subscriptions must dispose synchronously",
          ),
      };
    } catch (error) {
      this.#state = { phase: "closed" };
      throw error;
    }
    Object.freeze(this);
  }

  // Source listeners must not share the constructor's subscription or callback closure context.
  readonly synchronize = () => {
    const state = this.#state;
    if (state.phase !== "closed") state.synchronize();
  };

  close() {
    const state = this.#state;
    // Platform owns the withdrawal receipt; revocation must precede external disposal or failure.
    this.#state = { phase: "closed" };
    if (state.phase === "attached") state.withdraw();
  }
}
