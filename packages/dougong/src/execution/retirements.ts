import type { InstallationGraph } from "../composition/installation-graph.js";
import type { InstallationRecord } from "../composition/installation.js";
import type { Instance } from "./instance.js";

// One generation's actual bindings: release must follow these, not a candidate graph or another
// generation that happens to share an Installation id.
export interface ExecutionScope {
  readonly graph: InstallationGraph;
  readonly instances: ReadonlyMap<InstallationRecord, Instance>;
}

interface Retirement {
  readonly receipt: Promise<void>;
  readonly settled: Promise<void>;
}

// A provider stops only after every bound consumer has actually stopped. A failed consumer keeps
// its providers alive while independent branches continue to release.
export class Retirements {
  readonly #retirements = new WeakMap<Instance, Retirement>();
  readonly #reportReleaseFailure: (instance: Instance, error: unknown) => void;

  constructor(reportReleaseFailure: (instance: Instance, error: unknown) => void) {
    this.#reportReleaseFailure = reportReleaseFailure;
  }

  async release(scopes: ReadonlyArray<ExecutionScope>, targets: ReadonlySet<Instance>) {
    const dependents = boundConsumers(scopes);
    const pending: Promise<void>[] = [];
    for (const instance of [...targets].reverse()) {
      const current = this.#retirements.get(instance);
      if (current) {
        // The first release call owns its failure receipt; quarantine joins without duplicating it.
        pending.push(current.receipt.catch(() => undefined));
        continue;
      }
      if (instance.lifetime.phase === "disposed") continue;
      const retirement = this.#retire(instance, [...(dependents.get(instance) ?? [])]);
      this.#retirements.set(instance, retirement);
      pending.push(retirement.receipt);
    }
    const outcomes = await Promise.allSettled(pending);
    return outcomes.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
  }

  // The receipt may settle before the actual work: a busy or blocked release reports later failures.
  #retire(instance: Instance, consumers: ReadonlyArray<Instance>): Retirement {
    const completion = Promise.withResolvers<void>();
    let deferred = false;
    const deferReceipt = () => {
      deferred = true;
      completion.resolve();
    };
    // Register every branch before looking up joins, including bindings across generations.
    const settled = Promise.resolve().then(async () => {
      const dependents = consumers.map((consumer) => this.#retirements.get(consumer));
      void Promise.allSettled(dependents.map((dependent) => dependent?.receipt)).then(() => {
        // A failed receipt cannot hold the quarantine report open until actual work settles.
        if (consumers.some((consumer) => consumer.lifetime.phase !== "disposed")) deferReceipt();
      });
      await Promise.allSettled(
        consumers.map((consumer, index) => dependents[index]?.settled ?? consumer.settled),
      );
      if (consumers.some((consumer) => consumer.lifetime.phase !== "disposed")) return;

      const busy = instance.lifetime.busy;
      const release = instance.lifetime.stop();
      if (busy) deferReceipt();
      const releaseOutcome = release.then(
        () => {
          completion.resolve();
          return { status: "fulfilled" } as const;
        },
        (error: unknown) => {
          if (deferred) this.#reportReleaseFailure(instance, error);
          else completion.reject(error);
          return { status: "rejected", reason: error } as const;
        },
      );
      try {
        await instance.settled;
      } catch (error) {
        const outcome = await releaseOutcome;
        if (outcome.status === "fulfilled" || outcome.reason !== error)
          this.#reportReleaseFailure(instance, error);
        throw error;
      }
      await releaseOutcome;
    });
    void settled.then(completion.resolve, completion.reject);
    return Object.freeze({
      receipt: Object.freeze(completion.promise),
      settled: Object.freeze(settled),
    });
  }
}

function boundConsumers(scopes: ReadonlyArray<ExecutionScope>) {
  const dependents = new Map<Instance, Set<Instance>>();
  for (const { graph, instances } of scopes) {
    for (const [provider, consumers] of graph.dependents) {
      const instance = instances.get(provider);
      if (!instance) continue;
      const bound = dependents.get(instance) ?? new Set<Instance>();
      for (const consumer of consumers) {
        const dependent = instances.get(consumer);
        if (dependent) bound.add(dependent);
      }
      dependents.set(instance, bound);
    }
  }
  return dependents;
}
