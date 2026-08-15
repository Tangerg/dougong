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
  resolve(registration: Registration<Reference>): RegistrationRecord<Reference>;
  execute(operations: ReadonlyArray<PlatformChangeOperation<Reference>>): Promise<void>;
}

type PlatformChangeSetState<Reference> =
  | { readonly phase: "open"; readonly port: PlatformChangePort<Reference> }
  | { readonly phase: "committing" }
  | { readonly phase: "submitted"; readonly promise: Promise<void> };

/** One-shot draft that owns target uniqueness and delegates candidate validation. */
export class PlatformChangeSetDraft<Reference> implements PlatformChangeSet<Reference> {
  readonly #operations = new Map<
    RegistrationRecord<Reference>,
    PlatformChangeOperation<Reference>
  >();
  #state: PlatformChangeSetState<Reference>;

  constructor(port: PlatformChangePort<Reference>) {
    this.#state = { phase: "open", port };
    Object.freeze(this);
  }

  register<
    Config = void,
    Requires extends Requirements = {},
    Provides extends Provisions = {},
    ConfigInput = Config,
  >(artifact: Artifact<Reference, Config, Requires, Provides, ConfigInput>) {
    const port = this.#requireOpen();
    const normalized = port.normalize(artifact);
    const registration = port.createRegistration(normalized);
    this.#stage({ kind: "register", registration, artifact: normalized });
    return registration.publicRegistration;
  }

  update<
    Config = void,
    Requires extends Requirements = {},
    Provides extends Provisions = {},
    ConfigInput = Config,
  >(
    registration: Registration<Reference>,
    artifact: Artifact<Reference, Config, Requires, Provides, ConfigInput>,
  ) {
    const port = this.#requireOpen();
    const record = port.resolve(registration);
    const normalized = port.normalize(artifact);
    if (normalized.manifest.name !== record.manifestName) {
      throw new PlatformError(
        "REGISTRATION_IDENTITY",
        `Registration '${record.manifestName}' cannot change name to '${normalized.manifest.name}'`,
      );
    }
    this.#stage({ kind: "update", registration: record, artifact: normalized });
    return this;
  }

  remove(registration: Registration<Reference>) {
    const port = this.#requireOpen();
    this.#stage({ kind: "remove", registration: port.resolve(registration) });
    return this;
  }

  commit() {
    const state = this.#state;
    if (state.phase === "submitted") return state.promise;
    if (state.phase === "committing") {
      throw new Error("Platform ChangeSet commit is already being prepared");
    }
    this.#state = { phase: "committing" };
    const port = state.port;
    const operations = Object.freeze([...this.#operations.values()]);
    try {
      for (const operation of operations) {
        if (operation.kind === "register") port.attachRegistration(operation.registration);
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
      promise = port.execute(operations);
    } catch (error) {
      promise = Promise.reject(error);
    }
    for (const operation of operations) {
      if (operation.kind === "register") operation.registration.trackAdmission(promise);
    }
    return this.#submit(promise);
  }

  #stage(operation: PlatformChangeOperation<Reference>) {
    if (this.#operations.has(operation.registration)) {
      throw new TypeError(
        `Registration '${operation.registration.manifestName}' can only appear once in the same ChangeSet`,
      );
    }
    this.#operations.set(operation.registration, Object.freeze(operation));
  }

  #requireOpen() {
    const state = this.#state;
    if (state.phase !== "open") {
      throw new TypeError(`Cannot modify a ${state.phase} ChangeSet`);
    }
    return state.port;
  }

  #submit(promise: Promise<void>) {
    this.#state = { phase: "submitted", promise };
    this.#operations.clear();
    return promise;
  }
}
