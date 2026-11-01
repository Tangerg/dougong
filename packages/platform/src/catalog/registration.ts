import type { RecordedFailure, Installation } from "dougong";
import {
  describeArtifact,
  matchesArtifact,
  readArtifactOrigin,
  type Artifact,
  type ArtifactDescriptor,
  type ArtifactOrigin,
} from "../artifacts/artifact.js";
import { PlatformError } from "../errors.js";

export type RegistrationStatus =
  "selected" | "activating" | "removing" | "installed" | "failed" | "quarantined" | "removed";

export interface Registration<Reference> {
  readonly id: string;
  readonly name: string;
  readonly selectedArtifact: Artifact<Reference>;
  readonly selectionRevision: number;
  readonly activeOrigin: ArtifactOrigin | undefined;
  readonly installation: Installation | undefined;
  readonly status: RegistrationStatus;
  readonly error: RecordedFailure | undefined;
}

export interface RegistrationSnapshot {
  readonly id: string;
  readonly name: string;
  readonly selectedArtifact: ArtifactDescriptor;
  readonly selectionRevision: number;
  readonly activeOrigin: ArtifactOrigin | undefined;
  readonly status: RegistrationStatus;
  readonly execution: Installation["status"] | undefined;
  readonly error: RecordedFailure | undefined;
}

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
    const state = this.#state;
    if (state.phase === "removed") return "removed";
    if (this.installation?.status === "quarantined") return "quarantined";
    const operation = state.port.operation(this, state.revision);
    if (operation) return operation;
    if (state.error) return "failed";
    return this.actionFor(state.artifact) === "reuse" ? "installed" : "selected";
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
        "SELECTION_SUPERSEDED",
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

  snapshot(previous?: RegistrationSnapshot): RegistrationSnapshot {
    const state = this.#requireSelected();
    const selectedArtifact = describeArtifact(state.artifact);
    const activeOrigin = this.activeOrigin;
    const status = this.status;
    const execution = this.installation?.status;
    if (
      previous &&
      previous.selectedArtifact === selectedArtifact &&
      previous.selectionRevision === state.revision &&
      previous.activeOrigin === activeOrigin &&
      previous.status === status &&
      previous.execution === execution &&
      previous.error === state.error
    )
      return previous;
    return Object.freeze({
      id: this.id,
      name: this.name,
      selectedArtifact,
      selectionRevision: state.revision,
      activeOrigin,
      status,
      execution,
      error: state.error,
    });
  }

  #requireSelected() {
    const state = this.#state;
    if (state.phase === "removed")
      throw new PlatformError("REGISTRATION_UNAVAILABLE", `Registration '${this.name}' is removed`);
    return state;
  }
}
