import { createHost, definePlugin, service, type Installation, type Service } from "dougong";
import { exampleResult, type ExampleResult } from "./example";

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

export async function contractsAndGroups(): Promise<ExampleResult> {
  const trace: string[] = [];
  const host = createHost({ name: "contracts-groups" });
  let alphaProviderInstallation!: Installation<ReturnType<typeof storePlugin>>;
  let betaProviderInstallation!: Installation<ReturnType<typeof storePlugin>>;

  const alpha = host.group("alpha", (group) => {
    alphaProviderInstallation = group.install(
      storePlugin("examples.workspaces.alpha.store", ALPHA_STORE, "alpha"),
      1,
    );
    group.install(readerPlugin("examples.workspaces.alpha.reader", ALPHA_STORE, trace));
  });
  host.group("beta", (group) => {
    betaProviderInstallation = group.install(
      storePlugin("examples.workspaces.beta.store", BETA_STORE, "beta"),
      1,
    );
    group.install(readerPlugin("examples.workspaces.beta.reader", BETA_STORE, trace));
  });
  await host.start();

  const distinct = host.get(ALPHA_STORE).workspace !== host.get(BETA_STORE).workspace;
  const atStartup = [...trace];

  const change = host.change();
  change.update(alphaProviderInstallation, { config: 2 });
  change.update(betaProviderInstallation, { config: 2 });
  await change.commit();
  const versions = `alpha@${host.get(ALPHA_STORE).version}, beta@${host.get(BETA_STORE).version}`;

  await alpha.remove();
  let alphaAvailable = true;
  try {
    host.get(ALPHA_STORE);
  } catch {
    alphaAvailable = false;
  }
  const betaSurvived = host.get(BETA_STORE).version;
  await host.stop();

  return exampleResult({
    id: "06",
    stage: "composition",
    title: "One shape, many identities, and who owns which subtree",
    introduces: ["contract-family", "group", "atomic-commit", "group-removal"],
    facts: [
      `Two identities from one factory resolve to different Service values = ${distinct}.`,
      `At startup the readers observed ${atStartup.join(", ")}.`,
      `One ChangeSet moved both Groups together, rebuilding both readers: ${trace.slice(atStartup.length).join(", ")} → ${versions}.`,
      `Removing /alpha removed its installation subtree; ALPHA_STORE available = ${alphaAvailable}.`,
      `Ownership is structural, not transitive: /beta kept serving version ${betaSurvived}.`,
    ],
  });
}
