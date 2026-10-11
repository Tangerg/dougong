import type { ContractIdentity, ContractKind } from "./contracts";
import { DougongError } from "./errors";

// A Host must keep each Contract id bound to one kind even after its last Installation leaves.

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
    // Instances retain committed writers, so later declarations must reach the durable identity registry.
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
