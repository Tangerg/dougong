import type { RecordedFailure, Installation, InstallationSnapshot } from "dougong";
import {
  describeArtifact,
  matchesArtifact,
  readArtifactOrigin,
  type Artifact,
  type ArtifactDescriptor,
  type ArtifactOrigin,
} from "../artifacts/artifact.js";
import { PlatformError, registrationUnavailableCode, selectionSupersededCode } from "../errors.js";

type RegistrationStatusSnapshot =
  | { readonly status: "selected" | "installed"; readonly error: undefined }
  | { readonly status: "failed"; readonly error: RecordedFailure }
  | {
      readonly status: "activating" | "removing" | "quarantined";
      readonly error: RecordedFailure | undefined;
    };

export type RegistrationStatus = RegistrationStatusSnapshot["status"] | "removed";

declare const registrationBrand: unique symbol;

export interface Registration<Reference> {
  readonly [registrationBrand]: true;
  readonly id: string;
  readonly name: string;
  readonly selectedArtifact: Artifact<Reference>;
  readonly selectionRevision: number;
  readonly activeOrigin: ArtifactOrigin | undefined;
  readonly installation: Installation | undefined;
  readonly status: RegistrationStatus;
  readonly error: RecordedFailure | undefined;
}

export type RegistrationSnapshot = {
  readonly id: string;
  readonly name: string;
  readonly selectedArtifact: ArtifactDescriptor;
  readonly selectionRevision: number;
  readonly activeOrigin: ArtifactOrigin | undefined;
  readonly execution: InstallationSnapshot["status"] | undefined;
} & RegistrationStatusSnapshot;

export interface RegistrationPort<Reference> {
  readonly installation: (id: string) => Installation | undefined;
  readonly operation: (
    registration: RegistrationRecord<Reference>,
    revision: number,
  ) => "activating" | "removing" | undefined;
}

export interface Selection<Reference> {
  readonly registration: RegistrationRecord<Reference>;
  readonly revision: number;
  readonly artifact: Artifact<Reference>;
}

type RegistrationState<Reference> =
  | {
      readonly phase: "selected";
      readonly port: RegistrationPort<Reference>;
      readonly artifact: Artifact<Reference>;
      readonly installation: Installation | undefined;
      readonly revision: number;
      readonly error: RecordedFailure | undefined;
    }
  | {
      readonly phase: "removed";
      readonly revision: number;
    };

class RegistrationFacade<Reference> implements Registration<Reference> {
  declare readonly [registrationBrand]: true;
  readonly #record: RegistrationRecord<Reference>;

  constructor(record: RegistrationRecord<Reference>) {
    this.#record = record;
    Object.freeze(this);
  }

  get id() {
    return this.#record.id;
  }
  get name() {
    return this.#record.name;
  }
  get selectedArtifact() {
    return this.#record.selectedArtifact;
  }
  get selectionRevision() {
    return this.#record.selectionRevision;
  }
  get activeOrigin() {
    return this.#record.activeOrigin;
  }
  get installation() {
    return this.#record.installation;
  }
  get status() {
    return this.#record.status;
  }
  get error() {
    return this.#record.error;
  }
}

export class RegistrationRecord<Reference> {
  readonly id: string;
  readonly name: string;
  readonly #platformId: string;
  readonly facade: Registration<Reference>;
  #state: RegistrationState<Reference>;

  constructor(
    platformId: string,
    artifact: Artifact<Reference>,
    port: RegistrationPort<Reference>,
  ) {
    this.#platformId = platformId;
    this.name = artifact.manifest.name;
    this.id = `platform:${encodeURIComponent(platformId)}/${encodeURIComponent(this.name)}`;
    this.#state = {
      phase: "selected",
      artifact,
      port,
      installation: undefined,
      revision: 1,
      error: undefined,
    };
    this.facade = new RegistrationFacade(this);
    Object.freeze(this);
  }

  get selectedArtifact() {
    return this.#requireSelected().artifact;
  }

  get selectionRevision() {
    return this.#state.revision;
  }

  get installation() {
    const state = this.#state;
    return state.phase === "selected" &&
      state.installation &&
      state.port.installation(this.id) === state.installation
      ? state.installation
      : undefined;
  }

  bindInstallation(installation: Installation) {
    this.#state = { ...this.#requireSelected(), installation };
  }

  get activeOrigin() {
    return readArtifactOrigin(this.installation?.origin, this.#platformId, this.name);
  }

  actionFor(artifact: Artifact<Reference>): "install" | "update" | "reuse" {
    if (matchesArtifact(this.activeOrigin, artifact)) return "reuse";
    return this.installation ? "update" : "install";
  }

  get error() {
    const state = this.#state;
    return state.phase === "selected" ? state.error : undefined;
  }

  get status(): RegistrationStatus {
    return this.#state.phase === "removed"
      ? "removed"
      : this.#projectStatus(this.installation?.status).status;
  }

  select(artifact: Artifact<Reference>) {
    const state = this.#requireSelected();
    if (artifact.manifest.name !== this.name)
      throw new TypeError("Registration identity cannot change");
    if (state.artifact === artifact) return false;
    this.#state = { ...state, artifact, revision: state.revision + 1, error: undefined };
    return true;
  }

  capture(): Selection<Reference> {
    const state = this.#requireSelected();
    return Object.freeze({
      registration: this,
      revision: state.revision,
      artifact: state.artifact,
    });
  }

  assertCurrent(selection: Selection<Reference>) {
    const state = this.#state;
    if (
      state.phase !== "selected" ||
      state.revision !== selection.revision ||
      state.artifact !== selection.artifact
    ) {
      throw new PlatformError(
        selectionSupersededCode,
        `Selection for '${this.name}' changed during activation`,
      );
    }
  }

  clearFailure(revision: number) {
    const state = this.#state;
    if (state.phase === "selected" && state.revision === revision && state.error) {
      this.#state = { ...state, error: undefined };
    }
  }

  fail(revision: number, error: RecordedFailure) {
    const state = this.#state;
    if (state.phase === "selected" && state.revision === revision) {
      this.#state = { ...state, error };
    }
  }

  remove() {
    const state = this.#state;
    if (state.phase === "removed") return;
    this.#state = {
      phase: "removed",
      revision: state.revision,
    };
  }

  snapshot(
    execution: InstallationSnapshot["status"] | undefined,
    previous?: RegistrationSnapshot,
  ): RegistrationSnapshot {
    const state = this.#requireSelected();
    const selectedArtifact = describeArtifact(state.artifact);
    const activeOrigin = this.activeOrigin;
    const statusSnapshot = this.#projectStatus(execution);
    if (
      previous &&
      previous.selectedArtifact === selectedArtifact &&
      previous.selectionRevision === state.revision &&
      previous.activeOrigin === activeOrigin &&
      previous.status === statusSnapshot.status &&
      previous.execution === execution &&
      previous.error === statusSnapshot.error
    )
      return previous;
    return Object.freeze({
      id: this.id,
      name: this.name,
      selectedArtifact,
      selectionRevision: state.revision,
      activeOrigin,
      execution,
      ...statusSnapshot,
    });
  }

  #projectStatus(execution: Installation["status"] | undefined): RegistrationStatusSnapshot {
    const state = this.#requireSelected();
    if (execution === "quarantined") return { status: "quarantined", error: state.error };
    const operation = state.port.operation(this, state.revision);
    if (operation) return { status: operation, error: state.error };
    if (state.error) return { status: "failed", error: state.error };
    return {
      status: this.actionFor(state.artifact) === "reuse" ? "installed" : "selected",
      error: undefined,
    };
  }

  #requireSelected() {
    const state = this.#state;
    if (state.phase === "removed")
      throw new PlatformError(
        registrationUnavailableCode,
        `Registration '${this.name}' is removed`,
      );
    return state;
  }
}
