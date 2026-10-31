import { asyncDisposeSymbol } from "../contracts/resource.js";
import { Engine } from "./engine.js";
import type { Host, HostOptions } from "./host-api.js";

export function createHost(options?: HostOptions): Host {
  const engine = new Engine(options);
  return Object.freeze({
    get name() {
      return engine.name;
    },
    get status() {
      return engine.status;
    },
    get stateRevision() {
      return engine.stateRevision;
    },
    get diagnostics() {
      return engine.diagnostics;
    },
    change: () => engine.change(),
    plan: engine.plan.bind(engine),
    apply: engine.apply.bind(engine),
    start: () => engine.start(),
    stop: () => engine.stop(),
    use: engine.use.bind(engine),
    contributions: engine.contributions.bind(engine),
    installation: engine.installation.bind(engine),
    group: engine.group.bind(engine),
    explain: engine.explain.bind(engine),
    [asyncDisposeSymbol]: async () => {
      await engine.stop();
    },
  }) as Host;
}
