import { createHost, definePlugin, service, type Installation, type Service } from "dougong";
import { exampleResult, type ExampleResult } from "./example";

interface WorkspaceStore {
  readonly workspace: string;
  readonly version: number;
}

/**
 * A Contract family: one shape, many identities, each spelled out. Two
 * workspaces are two Services — not one Service resolved differently depending
 * on who is asking.
 */
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

/** Contract identity, installation ownership and atomic change stay three separate ideas. */
export async function contractsAndGroups(): Promise<ExampleResult> {
  const trace: string[] = [];
  const host = createHost({ name: "contracts-groups" });
  let alphaProvider!: Installation<number>;
  let betaProvider!: Installation<number>;

  // A Group owns an installation subtree. It is not a capability scope, not a
  // provider shadow tree and not a permission boundary.
  const alpha = host.group("alpha", (group) => {
    alphaProvider = group.install(
      storePlugin("examples.workspaces.alpha.store", ALPHA_STORE, "alpha"),
      1,
    );
    group.install(readerPlugin("examples.workspaces.alpha.reader", ALPHA_STORE, trace));
  });
  host.group("beta", (group) => {
    betaProvider = group.install(
      storePlugin("examples.workspaces.beta.store", BETA_STORE, "beta"),
      1,
    );
    group.install(readerPlugin("examples.workspaces.beta.reader", BETA_STORE, trace));
  });
  await host.start();

  const distinct = host.get(ALPHA_STORE).workspace !== host.get(BETA_STORE).workspace;
  const atStartup = [...trace];

  // One ChangeSet spanning two Groups: consumers see version 1 or version 2,
  // never one workspace ahead of the other.
  const change = host.change();
  change.update(alphaProvider, { config: 2 });
  change.update(betaProvider, { config: 2 });
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
      `Two identities from one factory resolve to different instances = ${distinct}.`,
      `At startup the readers observed ${atStartup.join(", ")}.`,
      `One ChangeSet moved both Groups together, rebuilding both readers: ${trace.slice(atStartup.length).join(", ")} → ${versions}.`,
      `Removing /alpha removed its installation subtree; ALPHA_STORE available = ${alphaAvailable}.`,
      `Ownership is structural, not transitive: /beta kept serving version ${betaSurvived}.`,
    ],
  });
}
