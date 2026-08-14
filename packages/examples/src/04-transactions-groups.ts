import { createApp, definePlugin, service, type PluginHandle, type Service } from "dougong";
import type { ExampleResult } from "./example";

interface WorkspaceStore {
  readonly workspace: string;
  readonly version: number;
}

const workspaceStore = (workspace: string) =>
  service<WorkspaceStore>(`examples/workspaces/${encodeURIComponent(workspace)}/store`);

const ALPHA_STORE = workspaceStore("alpha");
const BETA_STORE = workspaceStore("beta");

function storePlugin(name: string, token: Service<WorkspaceStore>, workspace: string) {
  return definePlugin({
    name,
    provides: { store: token },
    setup: (_ctx, version: number) => ({ store: { workspace, version } }),
  });
}

function readerPlugin(name: string, token: Service<WorkspaceStore>, trace: string[]) {
  return definePlugin({
    name,
    requires: { store: token },
    setup(ctx) {
      trace.push(`${ctx.store.workspace}@${ctx.store.version}`);
    },
  });
}

/** Contract families, Group ownership and ChangeSet remain three separate ideas. */
export async function transactionsAndGroups(): Promise<ExampleResult> {
  const trace: string[] = [];
  const app = createApp({ name: "transactions-groups" });
  let alphaProvider!: PluginHandle<number>;
  let betaProvider!: PluginHandle<number>;

  const alpha = app.group("alpha", (group) => {
    alphaProvider = group.install(
      storePlugin("examples.workspaces.alpha.store", ALPHA_STORE, "alpha"),
      1,
    );
    group.install(readerPlugin("examples.workspaces.alpha.reader", ALPHA_STORE, trace));
  });
  app.group("beta", (group) => {
    betaProvider = group.install(
      storePlugin("examples.workspaces.beta.store", BETA_STORE, "beta"),
      1,
    );
    group.install(readerPlugin("examples.workspaces.beta.reader", BETA_STORE, trace));
  });
  await app.start();

  const change = app.change();
  change.update(alphaProvider, { config: 2 });
  change.update(betaProvider, { config: 2 });
  await change.commit();
  const betaVersion = app.get(BETA_STORE).version;

  await alpha.remove();
  let alphaAvailable = true;
  try {
    app.get(ALPHA_STORE);
  } catch {
    alphaAvailable = false;
  }
  await app.stop();

  return Object.freeze({
    id: "04",
    title: "Explicit multi-instance Contracts, Group ownership and ChangeSet",
    facts: Object.freeze([
      `Consumers observed ${trace.join(", ")}.`,
      `One ChangeSet moved both providers to version ${betaVersion}.`,
      `Removing /alpha removed its installation subtree; alpha available = ${alphaAvailable}.`,
    ]),
  });
}
