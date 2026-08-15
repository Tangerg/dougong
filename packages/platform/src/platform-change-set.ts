import type { Provisions, Requirements } from "@dougongjs/core";
import { PlatformError } from "./errors";
import type { RegistrationRecord } from "./registration";
import type { Registration, NormalizedArtifact, PlatformChangeSet, Artifact } from "./platform-api";

export type PlatformChangeOperation<Reference> =
  | {
      readonly kind: "register";
      readonly registration: RegistrationRecord<Reference>;
      readonly artifact: NormalizedArtifact<Reference>;
    }
  | {
      readonly kind: "update";
      readonly registration: RegistrationRecord<Reference>;
      readonly artifact: NormalizedArtifact<Reference>;
    }
  | { readonly kind: "remove"; readonly registration: RegistrationRecord<Reference> };

export interface PlatformChangePort<Reference> {
  normalize<
    Config = void,
    Requires extends Requirements = {},
    Provides extends Provisions = {},
    ConfigInput = Config,
  >(
    artifact: Artifact<Reference, Config, Requires, Provides, ConfigInput>,
  ): NormalizedArtifact<Reference>;
  createRegistration(artifact: NormalizedArtifact<Reference>): RegistrationRecord<Reference>;
  attachRegistration(registration: RegistrationRecord<Reference>): void;
  resolve(plugin: Registration<Reference>): RegistrationRecord<Reference>;
  execute(operations: ReadonlyArray<PlatformChangeOperation<Reference>>): Promise<void>;
}

type PlatformChangeSetState<Reference> =
  | { readonly phase: "open"; readonly host: PlatformChangePort<Reference> }
  | { readonly phase: "committing" }
  | { readonly phase: "submitted"; readonly promise: Promise<void> };

/** One-shot draft that owns target uniqueness and delegates candidate validation. */
export class PlatformChangeSetDraft<Reference> implements PlatformChangeSet<Reference> {
  readonly #operations = new Map<
    RegistrationRecord<Reference>,
    PlatformChangeOperation<Reference>
  >();
  #state: PlatformChangeSetState<Reference>;

  constructor(host: PlatformChangePort<Reference>) {
    this.#state = { phase: "open", host };
    Object.freeze(this);
  }

  register<
    Config = void,
    Requires extends Requirements = {},
    Provides extends Provisions = {},
    ConfigInput = Config,
  >(artifact: Artifact<Reference, Config, Requires, Provides, ConfigInput>) {
    const host = this.#requireOpen();
    const normalized = host.normalize(artifact);
    const registration = host.createRegistration(normalized);
    this.#stage({ kind: "register", registration, artifact: normalized });
    return registration.handle;
  }

  update<
    Config = void,
    Requires extends Requirements = {},
    Provides extends Provisions = {},
    ConfigInput = Config,
  >(
    plugin: Registration<Reference>,
    artifact: Artifact<Reference, Config, Requires, Provides, ConfigInput>,
  ) {
    const host = this.#requireOpen();
    const registration = host.resolve(plugin);
    const normalized = host.normalize(artifact);
    if (normalized.manifest.name !== registration.name) {
      throw new PlatformError(
        "REGISTRATION_IDENTITY",
        `Registration '${registration.name}' cannot change name to '${normalized.manifest.name}'`,
      );
    }
    this.#stage({ kind: "update", registration, artifact: normalized });
    return this;
  }

  remove(plugin: Registration<Reference>) {
    const host = this.#requireOpen();
    this.#stage({ kind: "remove", registration: host.resolve(plugin) });
    return this;
  }

  commit() {
    const state = this.#state;
    if (state.phase === "submitted") return state.promise;
    if (state.phase === "committing") {
      throw new TypeError("Platform ChangeSet commit is already being prepared");
    }
    this.#state = { phase: "committing" };
    const host = state.host;
    const operations = Object.freeze([...this.#operations.values()]);
    try {
      for (const operation of operations) {
        if (operation.kind === "register") host.attachRegistration(operation.registration);
      }
    } catch (error) {
      for (const operation of operations) {
        if (operation.kind === "register") operation.registration.discard(error);
      }
      return this.#submit(Promise.reject(error));
    }
    if (!operations.length) {
      return this.#submit(Promise.resolve());
    }
    let promise: Promise<void>;
    try {
      promise = host.execute(operations);
    } catch (error) {
      promise = Promise.reject(error);
    }
    return this.#submit(promise);
  }

  #stage(operation: PlatformChangeOperation<Reference>) {
    if (this.#operations.has(operation.registration)) {
      throw new TypeError(
        `Plugin '${operation.registration.name}' can only appear once in the same ChangeSet`,
      );
    }
    this.#operations.set(operation.registration, Object.freeze(operation));
  }

  #requireOpen() {
    const state = this.#state;
    if (state.phase !== "open") {
      throw new TypeError(`Cannot modify a ${state.phase} ChangeSet`);
    }
    return state.host;
  }

  #submit(promise: Promise<void>) {
    this.#state = { phase: "submitted", promise };
    this.#operations.clear();
    return promise;
  }
}
