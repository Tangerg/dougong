import type { ContractIdentity, ContractKind } from "./contracts";
import { DougongError } from "./errors";

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

  draft(candidateKinds: ReadonlyMap<string, ContractKind>) {
    return new ContractRegistryDraft(this, candidateKinds);
  }

  commit(kinds: ReadonlyMap<string, ContractKind>) {
    for (const [id, kind] of kinds) this.assertCompatible({ id, kind });
    for (const [id, kind] of kinds) this.#kinds.set(id, kind);
  }
}

/** Transaction-local Contract identities that become durable only after commit. */
type ContractRegistryDraftState =
  | {
      readonly phase: "open";
      readonly registry: ContractRegistry;
      readonly pending: Map<string, ContractKind>;
    }
  | { readonly phase: "committed"; readonly registry: ContractRegistry }
  | { readonly phase: "discarded" };

export class ContractRegistryDraft {
  #state: ContractRegistryDraftState;

  constructor(registry: ContractRegistry, candidateKinds: ReadonlyMap<string, ContractKind>) {
    this.#state = { phase: "open", registry, pending: new Map() };
    for (const [id, kind] of candidateKinds) this.remember({ id, kind });
  }

  remember(contract: ContractIdentity) {
    const state = this.#state;
    if (state.phase === "committed") {
      state.registry.remember(contract);
      return;
    }
    if (state.phase === "discarded") {
      throw new TypeError("Contract registry draft has been discarded");
    }

    state.registry.assertCompatible(contract);
    if (state.registry.kinds.has(contract.id)) return;
    rememberContractKind(state.pending, contract);
  }

  commit() {
    const state = this.#state;
    if (state.phase !== "open") return;
    state.registry.commit(state.pending);
    this.#state = { phase: "committed", registry: state.registry };
  }

  discard() {
    if (this.#state.phase === "open") this.#state = { phase: "discarded" };
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
