import type { Installer } from "@dougongjs/core";
import { ActivationGate, type ActivationPermit } from "./activation-gate";
import { loadPlugin } from "./artifact";
import { PlatformError } from "./errors";
import type { Loader } from "./loader";
import { matchesVersion } from "./manifest";
import type { Authorizer } from "./permissions";
import { assertCurrentRegistration, type RegistrationRecord } from "./registration";

interface ActivationPorts<Reference> {
  readonly installer: Pick<Installer, "change">;
  readonly loader: Loader<Reference>;
  readonly authorizer: Authorizer;
}

/** A closed activation boundary that detaches from its owner when released. */
export class ActivationBarrier {
  #release: (() => void) | undefined;
  readonly settled: Promise<void>;

  constructor(settled: Promise<void>, release: () => void) {
    this.settled = settled;
    this.#release = release;
    Object.freeze(this);
  }

  release() {
    const release = this.#release;
    if (!release) return;
    this.#release = undefined;
    release();
  }
}

/**
 * Owns activation admission, dependency activation and target exclusion.
 *
 * Activation is depth-first: authorize, then activate dependencies, then load
 * this module, then install. Dependencies come before the load so a Registration
 * whose dependency cannot activate never imports its own module — the cheapest
 * failure happens first.
 *
 * `#locked` is separate from the gate. The gate stops *new* activation trees
 * during a change; `#locked` marks the specific Registrations that change is
 * touching, so they stay refused even after the gate reopens.
 */
export class Activator<Reference> {
  readonly #registrations: ReadonlyMap<string, RegistrationRecord<Reference>>;
  readonly #ports: () => ActivationPorts<Reference>;
  readonly #publish: () => void;
  readonly #locked = new Set<RegistrationRecord<Reference>>();
  readonly #gate = new ActivationGate();

  constructor(
    registrations: ReadonlyMap<string, RegistrationRecord<Reference>>,
    ports: () => ActivationPorts<Reference>,
    publish: () => void,
  ) {
    this.#registrations = registrations;
    this.#ports = ports;
    this.#publish = publish;
  }

  async activate(
    registration: RegistrationRecord<Reference>,
    signal: AbortSignal,
    inheritedPermit?: ActivationPermit,
  ) {
    assertCurrentRegistration(this.#registrations, registration);
    if (this.#locked.has(registration)) {
      throw new PlatformError(
        "REGISTRATION_BUSY",
        `Registration '${registration.manifestName}' is being changed`,
      );
    }
    // Already installed is success, not an error. Several activation events, or
    // several dependents, routinely ask for the same Registration.
    if (registration.status === "installed") return;

    const permit = inheritedPermit ?? this.#gate.enter();
    if (!permit) {
      throw new PlatformError(
        "REGISTRATION_BUSY",
        `Registration '${registration.manifestName}' cannot activate while a Platform change is committing`,
      );
    }
    const ownsPermit = inheritedPermit === undefined;

    try {
      registration.beginActivation();
      this.#publish();
      try {
        const { installer, loader, authorizer } = this.#ports();
        await authorizer.authorize(registration.manifest, signal);
        await this.#activateDependencies(registration, signal, permit);
        const plugin = await loadPlugin(loader, registration.artifact, signal);
        // Update when a placeholder is already installed, install when it is not.
        // The update path is the whole point of placeholders: the Installation
        // identity survives activation, so dependents see the Service change
        // rather than an Installation appear.
        const change = installer.change();
        let installation = registration.installation;
        if (installation) {
          change.update(installation, { plugin, config: registration.artifact.config });
        } else {
          installation = change.install(plugin, registration.artifact.config);
        }
        await change.commit();
        registration.commitActivation(installation);
        this.#publish();
      } catch (error) {
        const failure = registration.fail(error);
        this.#publish();
        throw failure;
      }
    } finally {
      if (ownsPermit) permit.release();
    }
  }

  stabilize(targets: ReadonlyArray<RegistrationRecord<Reference>>) {
    const settled = this.#gate.close();
    for (const registration of targets) {
      this.#locked.add(registration);
      registration.cancelActivation();
    }
    return new ActivationBarrier(settled, () => {
      this.#gate.open();
      for (const registration of targets) this.#locked.delete(registration);
    });
  }

  async #activateDependencies(
    registration: RegistrationRecord<Reference>,
    signal: AbortSignal,
    permit: ActivationPermit,
  ) {
    for (const [name, range] of Object.entries(registration.manifest.dependencies)) {
      signal.throwIfAborted();
      const dependency = this.#registrations.get(name);
      if (!dependency) {
        throw new PlatformError(
          "REGISTRATION_DEPENDENCY_MISSING",
          `Registration '${registration.manifestName}' requires missing Registration '${name}'`,
        );
      }
      if (!matchesVersion(dependency.manifest.version, range)) {
        throw new PlatformError(
          "REGISTRATION_DEPENDENCY_INCOMPATIBLE",
          `Registration '${registration.manifestName}' requires Registration '${name}' ${range}, found ${dependency.manifest.version}`,
        );
      }
      await dependency.activateAsDependency(permit);
    }
  }
}
