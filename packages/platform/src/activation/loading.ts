import {
  definePlugin,
  type AnyPlugin,
  type Plugin,
  type Provisions,
  type Requirements,
} from "dougong";
import type { Authorizer } from "../admission/permissions.js";
import type { Artifact } from "../artifacts/artifact.js";
import { PlatformError } from "../errors.js";
import type { Loader } from "../loaders/loader.js";

interface LoadingPorts<Reference> {
  readonly loader: Loader<Reference>;
  readonly authorizer: Authorizer;
}

class SharedLoad {
  readonly #controller = new AbortController();
  readonly #result: Promise<AnyPlugin>;
  #waiters = 0;
  #settled = false;

  constructor(load: (signal: AbortSignal) => Promise<AnyPlugin>) {
    this.#result = Promise.resolve()
      .then(() => load(this.#controller.signal))
      .finally(() => {
        this.#settled = true;
      });
  }

  get result() {
    return this.#result;
  }
  get cancelled() {
    return this.#controller.signal.aborted;
  }

  wait(signal: AbortSignal): Promise<AnyPlugin> {
    signal.throwIfAborted();
    this.#controller.signal.throwIfAborted();
    this.#waiters++;
    return new Promise<AnyPlugin>((resolve, reject) => {
      let completed = false;
      const finish = (settle: () => void) => {
        if (completed) return;
        completed = true;
        signal.removeEventListener("abort", abort);
        this.#waiters--;
        if (!this.#waiters && !this.#settled) this.#controller.abort();
        settle();
      };
      const abort = () => finish(() => reject(signal.reason));
      signal.addEventListener("abort", abort, { once: true });
      this.#result.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
    });
  }

  cancel() {
    this.#controller.abort();
  }
}

export class LoadedModules<Reference> {
  readonly #loads = new Map<Artifact<Reference>, SharedLoad>();
  #ports: LoadingPorts<Reference> | undefined;

  constructor(ports: LoadingPorts<Reference>) {
    this.#ports = ports;
  }

  load(artifact: Artifact<Reference>, signal: AbortSignal) {
    signal.throwIfAborted();
    const ports = this.#ports;
    if (!ports) throw new PlatformError("PLATFORM_UNAVAILABLE", "Module loading is closed");
    let operation = this.#loads.get(artifact);
    if (!operation || operation.cancelled) {
      operation = new SharedLoad(async (loadSignal) => {
        loadSignal.throwIfAborted();
        await ports.authorizer.authorize(
          Object.freeze({
            artifact: Object.freeze({ revision: artifact.revision, manifest: artifact.manifest }),
            operation: "load",
          }),
          loadSignal,
        );
        loadSignal.throwIfAborted();
        return loadPlugin(ports.loader, artifact, loadSignal);
      });
      this.#loads.set(artifact, operation);
      const current = operation;
      void operation.result.then(undefined, () => {
        if (this.#loads.get(artifact) === current) this.#loads.delete(artifact);
      });
    }
    return operation.wait(signal);
  }

  close() {
    this.#ports = undefined;
    for (const operation of this.#loads.values()) operation.cancel();
    this.#loads.clear();
  }
}

async function loadPlugin<Reference>(
  loader: Loader<Reference>,
  artifact: Artifact<Reference>,
  signal: AbortSignal,
): Promise<AnyPlugin> {
  let loaded: unknown;
  try {
    loaded = await loader.load(artifact.reference, signal);
  } catch (error) {
    if (signal.aborted && Object.is(error, signal.reason)) throw error;
    throw new PlatformError(
      "MODULE_LOAD_FAILED",
      `Failed to load Artifact '${artifact.manifest.name}'`,
      { cause: error },
    );
  }
  signal.throwIfAborted();
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
