import type { ContractIdentity, ContractKind } from "./contracts";
import { DougongError } from "./errors";

// One Contract id must mean one kind for the whole life of a Host. Otherwise
// `service("app.theme")` in one Plugin and `event("app.theme")` in another would
// silently name the same slot, and which meaning wins would depend on
// installation order.
//
// Kinds are learned as declarations arrive, which means they are learned during
// transactions that may still roll back. Hence the draft: identities seen by a
// change become durable only when that change commits.

/** Host-wide identity registry with an explicit draft commit boundary. */
export class ContractRegistry {
  readonly #kinds = new Map<string, ContractKind>();

  get kinds(): ReadonlyMap<string, ContractKind> {
    return this.#kinds;
  }

  assertCompatible(contract: ContractIdentity) {
    assertCompatibleKind(this.#kinds, contract);
  }

  remember(contract: ContractIdentity) {
    rememberContractKind(this.#kinds, contract);
  }

  writer(candidateKinds: ReadonlyMap<string, ContractKind>) {
    return new ContractRegistryWriter(this, candidateKinds);
  }

  commit(kinds: ReadonlyMap<string, ContractKind>) {
    for (const [id, kind] of kinds) this.assertCompatible({ id, kind });
    for (const [id, kind] of kinds) this.#kinds.set(id, kind);
  }
}

/** Staged identities become durable at commit; the same writer then writes directly. */
type ContractRegistryWriterState =
  | {
      readonly phase: "staged";
      readonly registry: ContractRegistry;
      readonly pending: Map<string, ContractKind>;
    }
  | { readonly phase: "committed"; readonly registry: ContractRegistry }
  | { readonly phase: "discarded" };

export class ContractRegistryWriter {
  #state: ContractRegistryWriterState;

  constructor(registry: ContractRegistry, candidateKinds: ReadonlyMap<string, ContractKind>) {
    this.#state = { phase: "staged", registry, pending: new Map() };
    for (const [id, kind] of candidateKinds) this.remember({ id, kind });
  }

  remember(contract: ContractIdentity) {
    const state = this.#state;
    // A live Instance keeps its port after its change commits, so a Contract
    // first named by a later `emit()` or `contribute()` arrives here through a
    // committed writer. There is no transaction left to stage it in, so
    // it goes straight to the durable registry — still kind-checked.
    if (state.phase === "committed") {
      state.registry.remember(contract);
      return;
    }
    if (state.phase === "discarded") {
      throw new Error("Contract registry writer has been discarded");
    }

    state.registry.assertCompatible(contract);
    if (state.registry.kinds.has(contract.id)) return;
    rememberContractKind(state.pending, contract);
  }

  commit() {
    const state = this.#state;
    if (state.phase !== "staged") return;
    state.registry.commit(state.pending);
    this.#state = { phase: "committed", registry: state.registry };
  }

  discard() {
    if (this.#state.phase === "staged") this.#state = { phase: "discarded" };
  }
}

export function rememberContractKind(kinds: Map<string, ContractKind>, contract: ContractIdentity) {
  assertCompatibleKind(kinds, contract);
  kinds.set(contract.id, contract.kind);
}

function assertCompatibleKind(
  kinds: ReadonlyMap<string, ContractKind>,
  contract: ContractIdentity,
) {
  const previous = kinds.get(contract.id);
  if (previous && previous !== contract.kind) {
    throw new DougongError(
      "CONTRACT_CONFLICT",
      `Contract '${contract.id}' is used as both '${previous}' and '${contract.kind}'`,
    );
  }
}
