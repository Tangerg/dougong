import {
  definePlugin,
  type AnyPlugin,
  type Plugin,
  type Provisions,
  type Requirements,
} from "dougong";
import type { Authorizer } from "../admission/permissions.js";
import { describeArtifact, type Artifact } from "../artifacts/artifact.js";
import { PlatformError } from "../errors.js";
import type { Loader } from "../loaders/loader.js";
import { Preparation } from "./preparation.js";

interface LoadingPorts<Reference> {
  readonly loader: Loader<Reference>;
  readonly assertPlacement: () => void;
  readonly authorizer: Authorizer;
}

export class LoadedModules<Reference> {
  #state:
    | (LoadingPorts<Reference> & {
        readonly loads: WeakMap<Artifact<Reference>, Preparation<AnyPlugin>>;
      })
    | undefined;

  constructor(ports: LoadingPorts<Reference>) {
    this.#state = { ...ports, loads: new WeakMap() };
  }

  load(artifact: Artifact<Reference>, signal: AbortSignal) {
    AbortSignal.prototype.throwIfAborted.call(signal);
    const { loads } = this.#ports();
    let operation = loads.get(artifact);
    if (!operation || operation.cancelled) {
      operation = Preparation.start((loadSignal) => this.#load(artifact, loadSignal));
      loads.set(artifact, operation);
      const current = operation;
      void operation.result.then(undefined, () => {
        if (loads.get(artifact) === current) loads.delete(artifact);
      });
    }
    return operation.wait(signal);
  }

  #ports() {
    if (!this.#state) throw new PlatformError("PLATFORM_UNAVAILABLE", "Module loading is closed");
    return this.#state;
  }

  async #load(artifact: Artifact<Reference>, signal: AbortSignal) {
    AbortSignal.prototype.throwIfAborted.call(signal);
    this.#ports().assertPlacement();
    await Preparation.waitFor(
      (admissionSignal) =>
        this.#ports().authorizer.authorize(
          Object.freeze({ artifact: describeArtifact(artifact), operation: "load" }),
          admissionSignal,
        ),
      signal,
    );
    AbortSignal.prototype.throwIfAborted.call(signal);
    const ports = this.#ports();
    // An admission decision does not keep the destination Host or Group alive across the await.
    ports.assertPlacement();
    return loadPlugin(ports.loader, artifact, signal);
  }

  close() {
    // Activation waiters have settled; their last departure cancels any unfinished load.
    this.#state = undefined;
  }
}

async function loadPlugin<Reference>(
  loader: Loader<Reference>,
  artifact: Artifact<Reference>,
  signal: AbortSignal,
): Promise<AnyPlugin> {
  let loaded: unknown;
  try {
    const result = await Preparation.waitFor(
      (loadSignal) => resolveModule(loader.load(artifact.reference, loadSignal)),
      signal,
    );
    loaded = result.module;
  } catch (error) {
    AbortSignal.prototype.throwIfAborted.call(signal);
    throw new PlatformError(
      "MODULE_LOAD_FAILED",
      `Failed to load Artifact '${artifact.manifest.name}'`,
      { cause: error },
    );
  }
  AbortSignal.prototype.throwIfAborted.call(signal);
  let plugin: AnyPlugin;
  try {
    if (!loaded || (typeof loaded !== "object" && typeof loaded !== "function")) {
      throw new TypeError("Loader must return a module object");
    }
    const descriptor = Object.getOwnPropertyDescriptor(loaded, "default");
    if (!descriptor || !("value" in descriptor))
      throw new TypeError("Module must default-export a Plugin");
    plugin = definePlugin(descriptor.value as Plugin<unknown, Requirements, Provisions, unknown>);
  } catch (error) {
    throw new PlatformError(
      "MODULE_INVALID",
      `Artifact '${artifact.manifest.name}' does not default-export a valid Plugin`,
      { cause: error },
    );
  }
  if (plugin.name !== artifact.manifest.name) {
    throw new PlatformError(
      "ARTIFACT_IDENTITY",
      `Artifact '${artifact.manifest.name}' loaded Plugin '${plugin.name}'`,
    );
  }
  return plugin;
}

// Only the Loader result crosses the thenable boundary. Sharing it with waiters must not resolve it again.
async function resolveModule(result: unknown) {
  return { module: await result };
}
