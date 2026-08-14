import {
  createApp,
  createPlatform,
  definePlugin,
  extension,
  MemoryPluginLoader,
  PermissionSet,
  type ExtensionView,
  type ManagedPlugin,
  type PluginArtifact,
} from "dougong";
import type { ExampleResult } from "./example";

interface View {
  readonly id: string;
  readonly label: string;
}

interface ModuleDeclaration {
  readonly id: string;
  readonly imports: ReadonlyArray<string>;
  /** Plugin name for an entry module; ordinary modules leave this absent. */
  readonly plugin?: string;
}

interface Invalidation {
  readonly changed: ReadonlyArray<string>;
  readonly modules: ReadonlyArray<string>;
  readonly plugins: ReadonlyArray<string>;
}

const VIEWS = extension<View>("examples/hmr-module-graph/views");
const OUTLINE = "examples.hmr-module-graph.outline";
const SEARCH = "examples.hmr-module-graph.search";
const THEME = "examples.hmr-module-graph.theme";

/** Immutable import graph. A watcher supplies changed IDs; the graph never guesses from globals. */
class ModuleGraph {
  readonly #modules: ReadonlyMap<string, Readonly<ModuleDeclaration>>;
  readonly #importers: ReadonlyMap<string, ReadonlySet<string>>;

  constructor(declarations: ReadonlyArray<ModuleDeclaration>) {
    const modules = new Map<string, Readonly<ModuleDeclaration>>();
    for (const declaration of declarations) {
      if (modules.has(declaration.id)) throw new TypeError(`Duplicate module '${declaration.id}'`);
      modules.set(
        declaration.id,
        Object.freeze({ ...declaration, imports: Object.freeze([...declaration.imports]) }),
      );
    }

    const importers = new Map<string, Set<string>>(
      [...modules.keys()].map((id) => [id, new Set<string>()]),
    );
    for (const declaration of modules.values()) {
      for (const dependency of declaration.imports) {
        const dependents = importers.get(dependency);
        if (!dependents) {
          throw new TypeError(`Module '${declaration.id}' imports unknown module '${dependency}'`);
        }
        dependents.add(declaration.id);
      }
    }

    this.#modules = modules;
    this.#importers = importers;
  }

  invalidate(changed: ReadonlyArray<string>): Invalidation {
    const queue: string[] = [];
    const affected = new Set<string>();
    for (const id of changed) {
      if (!this.#modules.has(id)) throw new TypeError(`Changed module '${id}' is not in the graph`);
      if (affected.has(id)) continue;
      affected.add(id);
      queue.push(id);
    }

    for (const id of queue) {
      for (const importer of this.#importers.get(id) ?? []) {
        if (affected.has(importer)) continue;
        affected.add(importer);
        queue.push(importer);
      }
    }

    const plugins = new Set<string>();
    for (const id of affected) {
      const plugin = this.#modules.get(id)?.plugin;
      if (plugin) plugins.add(plugin);
    }
    return Object.freeze({
      changed: Object.freeze([...new Set(changed)]),
      modules: Object.freeze([...affected]),
      plugins: Object.freeze([...plugins]),
    });
  }
}

function viewPlugin(name: string, key: string, label: string) {
  return definePlugin({
    name,
    setup(ctx) {
      ctx.contribute(VIEWS, key, { id: key, label });
    },
  });
}

function artifact(name: string, version: string, reference: string): PluginArtifact<string> {
  return Object.freeze({
    manifest: { name, version, activation: ["startup"] },
    reference,
  });
}

/** Explicit module invalidation selects updates; Platform still owns the only plugin transaction. */
export async function hmrModuleGraph(): Promise<ExampleResult> {
  let views!: ExtensionView<View>;
  const snapshots: string[] = [];
  const observer = definePlugin({
    name: "examples.hmr-module-graph.observer",
    requires: { views: VIEWS },
    setup(ctx) {
      views = ctx.views;
      const capture = () => {
        snapshots.push(
          [...ctx.views.get().values()]
            .map((view) => view.label)
            .sort()
            .join("+"),
        );
      };
      const subscription = ctx.views.subscribe(capture);
      ctx.cleanup(() => subscription.dispose());
    },
  });

  const modules = new Map<string, unknown>([
    ["outline-v1", { default: viewPlugin(OUTLINE, "outline", "Outline v1") }],
    ["outline-v2", { default: viewPlugin(OUTLINE, "outline", "Outline v2") }],
    ["search-v1", { default: viewPlugin(SEARCH, "search", "Search v1") }],
    ["search-v2", { default: viewPlugin(SEARCH, "search", "Search v2") }],
    ["theme-v1", { default: viewPlugin(THEME, "theme", "Theme v1") }],
    ["theme-v2", { default: viewPlugin(THEME, "theme", "Theme v2") }],
  ]);
  const app = createApp({ name: "hmr-module-graph-example" });
  app.install(observer);
  await app.start();
  const platform = createPlatform({
    container: app,
    apiVersion: "1.0.0",
    permissions: new PermissionSet(),
    loader: new MemoryPluginLoader<string>(modules),
  });

  const handles = new Map<string, ManagedPlugin<string>>();
  const first = platform.change();
  handles.set(OUTLINE, first.register(artifact(OUTLINE, "1.0.0", "outline-v1")));
  handles.set(SEARCH, first.register(artifact(SEARCH, "1.0.0", "search-v1")));
  handles.set(THEME, first.register(artifact(THEME, "1.0.0", "theme-v1")));
  await first.commit();
  await platform.trigger("startup");
  const before = [...views.get().values()]
    .map((view) => view.label)
    .sort()
    .join(", ");

  const graph = new ModuleGraph([
    { id: "shared/icons.ts", imports: [] },
    { id: "outline/entry.ts", imports: ["shared/icons.ts"], plugin: OUTLINE },
    { id: "search/query.ts", imports: ["shared/icons.ts"] },
    { id: "search/entry.ts", imports: ["search/query.ts"], plugin: SEARCH },
    { id: "theme/entry.ts", imports: [], plugin: THEME },
  ]);
  const invalidation = graph.invalidate(["shared/icons.ts"]);
  const replacements = new Map<string, PluginArtifact<string>>([
    [OUTLINE, artifact(OUTLINE, "2.0.0", "outline-v2")],
    [SEARCH, artifact(SEARCH, "2.0.0", "search-v2")],
    [THEME, artifact(THEME, "2.0.0", "theme-v2")],
  ]);
  const change = platform.change();
  for (const name of invalidation.plugins) {
    const handle = handles.get(name);
    const replacement = replacements.get(name);
    if (!handle || !replacement) {
      throw new TypeError(`HMR plan is incomplete for plugin '${name}'`);
    }
    change.update(handle, replacement);
  }
  snapshots.length = 0;
  await change.commit();

  const after = [...views.get().values()]
    .map((view) => view.label)
    .sort()
    .join(", ");
  const publishedSnapshots = [...snapshots];

  await platform.dispose();
  await app.stop();

  return Object.freeze({
    id: "09",
    title: "Explicit module-graph invalidation compiled into Platform HMR",
    facts: Object.freeze([
      `Before invalidation the host saw ${before}.`,
      `Changing ${invalidation.changed.join(", ")} invalidated ${invalidation.modules.join(" → ")}.`,
      `Affected plugin entries were ${invalidation.plugins.join(", ")}; the unrelated theme was excluded.`,
      `One Platform ChangeSet published ${after}.`,
      `The Extension observer saw ${publishedSnapshots.length} committed snapshot: ${publishedSnapshots.join(", ")}.`,
    ]),
  });
}
