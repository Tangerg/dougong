import {
  normalizeContract,
  type ContractIdentity,
  type ExtensionPoint,
  type ExtensionPointIdentity,
} from "../contracts/contracts.js";
import { DougongError, lifetimeDisposedCode } from "../contracts/errors.js";
import type { Lifetime, LifetimeOwnership } from "../lifetime/lifetime.js";
import { assertTrimmedText } from "../internal/text.js";
import { combineFailures } from "../internal/failures.js";
import { batchSnapshotNotifications } from "../observation/snapshot-view.js";
import { ContributionStore, type Contribution } from "./contribution-store.js";
import { ContributionViewHandle, type ContributionView } from "./contribution-view.js";

export interface ContributionOperations {
  add<T>(
    token: ExtensionPoint<T>,
    key: string,
    value: T,
    options?: LifetimeOwnership,
  ): Contribution<T>;
}

export class ContributionRegistry {
  readonly #stores = new Map<string, ContributionStore<unknown>>();
  readonly #invalidated = new Set<ContributionStore<unknown>>();
  readonly #report: (error: unknown) => void;
  #batchDepth = 0;
  #hostViewsSealed = false;

  constructor(report: (error: unknown) => void) {
    this.#report = report;
  }

  store<T = unknown>(token: ExtensionPointIdentity): ContributionStore<T> {
    const id = token.id;
    const current = this.#stores.get(id);
    if (current) return current as ContributionStore<T>;
    const store = new ContributionStore<T>(
      {
        invalidate: (item) => this.#invalidate(item),
        release: (item) => {
          if (this.#stores.get(id) !== item) return;
          this.#invalidated.delete(item);
          this.#stores.delete(id);
        },
      },
      this.#report,
    );
    this.#stores.set(id, store as ContributionStore<unknown>);
    return store;
  }

  view<T = unknown>(token: ExtensionPointIdentity, owner?: Lifetime): ContributionView<T> {
    if (!owner && this.#hostViewsSealed) {
      return new ContributionViewHandle<T>({
        binding: { phase: "sealed", snapshot: Object.freeze([]) },
      });
    }
    const store = this.store<T>(token);
    return owner ? store.view(owner) : store.hostView();
  }

  sealHostViews() {
    if (this.#hostViewsSealed) return;
    this.#hostViewsSealed = true;
    const errors: unknown[] = [];
    for (const store of this.#stores.values()) {
      try {
        store.sealHostView();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw combineFailures(errors, "Contribution view sealing failed");
  }

  scope(
    owner: Lifetime,
    installationId: string,
    remember: (token: ContractIdentity) => void,
  ): ContributionOperations {
    return new ContributionScope(this, owner, installationId, remember);
  }

  beginBatch() {
    this.#batchDepth++;
  }

  // Attempt every publication so one broken store cannot strand the others with stale snapshots.
  endBatch() {
    if (!this.#batchDepth) throw new Error("Contribution batch is not active");
    this.#batchDepth--;
    if (this.#batchDepth) return;
    const stores = [...this.#invalidated];
    this.#invalidated.clear();
    batchSnapshotNotifications(() => {
      const errors: unknown[] = [];
      for (const store of stores) {
        try {
          store.publishSnapshot();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw combineFailures(errors, "Contribution batch publication failed");
    });
  }

  #invalidate(store: ContributionStore<unknown>) {
    this.#invalidated.add(store);
    if (this.#batchDepth) return;
    this.#invalidated.delete(store);
    store.publishSnapshot();
  }
}

// Escaping prevents different Installation/key pairs from producing the same contribution id.
function contributionId(installationId: string, key: string) {
  return `${escapeIdPart(installationId)}/${escapeIdPart(key)}`;
}

function escapeIdPart(value: string) {
  return value.replaceAll("%", "%25").replaceAll("/", "%2F");
}

class ContributionScope implements ContributionOperations {
  #binding:
    | {
        readonly registry: ContributionRegistry;
        readonly owner: Lifetime;
        readonly installationId: string;
        readonly remember: (token: ContractIdentity) => void;
      }
    | undefined;

  constructor(
    registry: ContributionRegistry,
    owner: Lifetime,
    installationId: string,
    remember: (token: ContractIdentity) => void,
  ) {
    this.#binding = { registry, owner, installationId, remember };
    owner.defer(() => {
      this.#binding = undefined;
    });
    Object.freeze(this);
  }

  add<T>(
    token: ExtensionPoint<T>,
    key: string,
    value: T,
    options?: LifetimeOwnership,
  ): Contribution<T> {
    const binding = this.#binding;
    if (!binding || !binding.owner.acceptsWork) {
      throw new DougongError(lifetimeDisposedCode, "Contribution scope is closed");
    }
    const identity = normalizeContract(token, "extensionPoint");
    assertTrimmedText(key, "Contribution key");
    const owner = binding.owner.resolveOwner(options);
    return binding.registry
      .store<T>(identity)
      .stage(contributionId(binding.installationId, key), value, owner, () =>
        binding.remember(identity),
      );
  }
}
