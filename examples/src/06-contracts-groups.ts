import {
  createResourceAuthority,
  createHost,
  definePlugin,
  optional,
  service,
  type Service,
} from "dougong";
import { exampleResult, type ExampleResult } from "./example.js";

const resourceAuthority = createResourceAuthority();

interface WorkspaceStore {
  readonly workspace: string;
  readonly version: number;
}

const workspaceStore = (workspace: string) =>
  service<WorkspaceStore>(`examples/workspaces/${encodeURIComponent(workspace)}/store`);
const alphaWorkspaceId = "alpha";
const betaWorkspaceId = "beta";
const ALPHA_STORE = workspaceStore(alphaWorkspaceId);
const BETA_STORE = workspaceStore(betaWorkspaceId);

function storePlugin(name: string, token: Service<WorkspaceStore>, workspace: string) {
  return definePlugin({
    name,
    provides: { store: token },
    setup: (_context, version: number) => ({ store: { workspace, version } }),
  });
}

function readerPlugin(name: string, token: Service<WorkspaceStore>, trace: string[]) {
  return definePlugin({
    name,
    requires: { store: token },
    setup({ dependencies }) {
      trace.push(`${dependencies.store.workspace}@${dependencies.store.version}`);
    },
  });
}

export async function contractsAndGroups(): Promise<ExampleResult> {
  const trace: string[] = [];
  const host = createHost({ resourceAuthority, name: "contracts-groups" });
  const initial = host.change();
  const alpha = initial.group(alphaWorkspaceId);
  const beta = initial.group(betaWorkspaceId);
  const alphaProvider = initial.install(
    storePlugin("examples.workspaces.alpha.store", ALPHA_STORE, alphaWorkspaceId),
    { id: "alpha-store", group: alpha, configuration: 1 },
  );
  const betaProvider = initial.install(
    storePlugin("examples.workspaces.beta.store", BETA_STORE, betaWorkspaceId),
    { id: "beta-store", group: beta, configuration: 1 },
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

  const { value: alphaWorkspace } = await host.use(ALPHA_STORE, (store) => store.workspace);
  const { value: betaWorkspace } = await host.use(BETA_STORE, (store) => store.workspace);
  const atStartup = [...trace];
  const change = host.change();
  change.update(alphaProvider, { configuration: 2 });
  change.update(betaProvider, { configuration: 2 });
  const plan = await host.plan(change);
  await host.apply(plan);
  const versions = `alpha@${(await host.use(ALPHA_STORE, (store) => store.version)).value}, beta@${(await host.use(BETA_STORE, (store) => store.version)).value}`;

  const remove = host.change();
  remove.removeGroup(alpha);
  await host.apply(await host.plan(remove));
  const { value: alphaAvailable } = await host.use(
    optional(ALPHA_STORE),
    (store) => store !== undefined,
  );
  const { value: betaSurvived } = await host.use(BETA_STORE, (store) => store.version);
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
