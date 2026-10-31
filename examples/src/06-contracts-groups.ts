import { createHost, definePlugin, service, type Service } from "dougong";
import { exampleResult, type ExampleResult } from "./example.js";

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
    setup({ deps }) {
      trace.push(`${deps.store.workspace}@${deps.store.version}`);
    },
  });
}

export async function contractsAndGroups(): Promise<ExampleResult> {
  const trace: string[] = [];
  const host = createHost({ name: "contracts-groups" });
  const initial = host.change();
  const alpha = initial.group("alpha");
  const beta = initial.group("beta");
  const alphaProvider = initial.install(
    storePlugin("examples.workspaces.alpha.store", ALPHA_STORE, "alpha"),
    { id: "alpha-store", group: alpha, config: 1 },
  );
  const betaProvider = initial.install(
    storePlugin("examples.workspaces.beta.store", BETA_STORE, "beta"),
    { id: "beta-store", group: beta, config: 1 },
  );
  initial.install(readerPlugin("examples.workspaces.alpha.reader", ALPHA_STORE, trace), {
    id: "alpha-reader",
    group: alpha,
  });
  initial.install(readerPlugin("examples.workspaces.beta.reader", BETA_STORE, trace), {
    id: "beta-reader",
    group: beta,
  });
  await host.apply(await host.plan(initial));
  await host.start();

  const alphaWorkspace = await host.use(ALPHA_STORE, (store) => store.workspace);
  const betaWorkspace = await host.use(BETA_STORE, (store) => store.workspace);
  const atStartup = [...trace];
  const change = host.change();
  change.update(alphaProvider, { config: 2 });
  change.update(betaProvider, { config: 2 });
  const plan = await host.plan(change);
  await host.apply(plan);
  const versions = `alpha@${await host.use(ALPHA_STORE, (store) => store.version)}, beta@${await host.use(BETA_STORE, (store) => store.version)}`;

  const remove = host.change();
  remove.removeGroup(alpha);
  await host.apply(await host.plan(remove));
  let alphaAvailable = true;
  try {
    await host.use(ALPHA_STORE, () => undefined);
  } catch {
    alphaAvailable = false;
  }
  const betaSurvived = await host.use(BETA_STORE, (store) => store.version);
  await host.stop();

  return exampleResult({
    id: "06",
    title: "One shape, many identities, and who owns which subtree",
    facts: [
      `Two identities resolve to different Service values = ${alphaWorkspace !== betaWorkspace}.`,
      `At startup the readers observed ${atStartup.join(", ")}.`,
      `One Plan explained ${plan.report.affectedInstallations.length} affected Installations and published ${versions}.`,
      `Removing /alpha removed its installation subtree; ALPHA_STORE available = ${alphaAvailable}.`,
      `Ownership is structural, not transitive: /beta kept serving version ${betaSurvived}.`,
    ],
  });
}
