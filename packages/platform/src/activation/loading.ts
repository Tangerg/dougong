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

interface LoadingPorts<Reference> {
  readonly loader: Loader<Reference>;
  readonly authorizer: Authorizer;
}

interface LoadWaiter {
  resolve: (plugin: AnyPlugin) => void;
  reject: (reason: unknown) => void;
}

class SharedLoad {
  readonly #controller = new AbortController();
  readonly result: Promise<AnyPlugin>;
  #waiters: Set<LoadWaiter> | undefined = new Set();

  constructor(load: (signal: AbortSignal) => Promise<AnyPlugin>) {
    this.result = Promise.resolve().then(() => load(this.#controller.signal));
    // One reaction per load: an aborted caller can release all its references even if the loader never settles.
    void this.result.then(
      (plugin) => this.#settle((waiter) => waiter.resolve(plugin)),
      (error) => this.#settle((waiter) => waiter.reject(error)),
    );
  }

  get cancelled() {
    return this.#controller.signal.aborted;
  }

  wait(signal: AbortSignal): Promise<AnyPlugin> {
    signal.throwIfAborted();
    this.#controller.signal.throwIfAborted();
    const waiters = this.#waiters;
    if (!waiters) return this.result;
    return new Promise<AnyPlugin>((resolve, reject) => {
      const waiter: LoadWaiter = {
        resolve: (plugin) => {
          signal.removeEventListener("abort", abort);
          resolve(plugin);
        },
        reject: (reason) => {
          signal.removeEventListener("abort", abort);
          reject(reason);
        },
      };
      const abort = () => {
        waiters.delete(waiter);
        if (!waiters.size) this.#controller.abort();
        waiter.reject(signal.reason);
      };
      waiters.add(waiter);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  #settle(complete: (waiter: LoadWaiter) => void) {
    const waiters = this.#waiters!;
    this.#waiters = undefined;
    for (const waiter of waiters) complete(waiter);
    waiters.clear();
  }
}

export class LoadedModules<Reference> {
  #state:
    | (LoadingPorts<Reference> & { readonly loads: WeakMap<Artifact<Reference>, SharedLoad> })
    | undefined;

  constructor(ports: LoadingPorts<Reference>) {
    this.#state = { ...ports, loads: new WeakMap() };
  }

  load(artifact: Artifact<Reference>, signal: AbortSignal) {
    signal.throwIfAborted();
    const ports = this.#state;
    if (!ports) throw new PlatformError("PLATFORM_UNAVAILABLE", "Module loading is closed");
    let operation = ports.loads.get(artifact);
    if (!operation || operation.cancelled) {
      operation = new SharedLoad(async (loadSignal) => {
        loadSignal.throwIfAborted();
        await ports.authorizer.authorize(
          Object.freeze({
            artifact: describeArtifact(artifact),
            operation: "load",
          }),
          loadSignal,
        );
        loadSignal.throwIfAborted();
        return loadPlugin(ports.loader, artifact, loadSignal);
      });
      ports.loads.set(artifact, operation);
      const current = operation;
      void operation.result.then(undefined, () => {
        if (ports.loads.get(artifact) === current) ports.loads.delete(artifact);
      });
    }
    return operation.wait(signal);
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
