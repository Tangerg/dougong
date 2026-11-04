import { asyncDisposeSymbol, type ApplyResult, type SnapshotView } from "dougong";
import { captureDataArray, SerialQueue } from "dougong/advanced";
import {
  createPlatform,
  type Artifact,
  type Catalog,
  type Platform,
  type PlatformOptions,
  type PlatformSnapshot,
} from "@dougongjs/platform";

export class DeploymentController<Reference> implements AsyncDisposable {
  readonly catalog: Catalog<Reference>;
  readonly diagnostics: SnapshotView<PlatformSnapshot>;
  readonly #platform: Platform<Reference>;
  readonly #requests = new SerialQueue();

  constructor(options: PlatformOptions<Reference>) {
    // A private Platform prevents another command path from changing a request's selections.
    this.#platform = createPlatform(options);
    this.catalog = this.#platform.catalog;
    this.diagnostics = this.#platform.diagnostics;
  }

  // Callbacks inside a request cannot await a later deployment that is queued behind themselves.
  async deploy(desired: ReadonlyArray<Artifact<Reference>>): Promise<ApplyResult | undefined> {
    const artifacts = captureDataArray(desired, "Desired deployment artifacts");
    const { value } = await this.#requests.run(async () => {
      const targets = await this.#platform.select(artifacts);
      const retained = new Set(targets);
      const remove = this.#platform
        .registrations()
        .filter((registration) => !retained.has(registration));
      return this.#platform.activate(targets, { remove });
    });
    return value;
  }

  [asyncDisposeSymbol](): Promise<void> {
    // Disposal must reach Platform immediately so blocked loading cannot hold shutdown behind it.
    return this.#platform[asyncDisposeSymbol]();
  }
}
