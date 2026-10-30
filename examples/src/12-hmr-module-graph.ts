import { createHost, definePlugin, extensionPoint, type ContributionView } from "dougong";
import {
  createPlatform,
  MemoryLoader,
  type Registration,
  type Artifact,
  type Platform,
} from "@dougongjs/platform";
import { exampleResult, type ExampleResult } from "./example.js";

interface View {
  readonly id: string;
  readonly label: string;
}

interface ModuleDeclaration {
  readonly id: string;
  readonly imports: ReadonlyArray<string>;
  readonly registration?: string;
}

interface Invalidation {
  readonly changed: ReadonlyArray<string>;
  readonly modules: ReadonlyArray<string>;
  readonly registrations: ReadonlyArray<string>;
}

const VIEWS = extensionPoint<View>("examples/hmr-module-graph/views");
const OUTLINE = "examples.hmr-module-graph.outline";
const SEARCH = "examples.hmr-module-graph.search";
const THEME = "examples.hmr-module-graph.theme";

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

    const registrations = new Set<string>();
    for (const id of affected) {
      const registration = this.#modules.get(id)?.registration;
      if (registration) registrations.add(registration);
    }
    return Object.freeze({
      changed: Object.freeze([...new Set(changed)]),
      modules: Object.freeze([...affected]),
      registrations: Object.freeze([...registrations]),
    });
  }
}

function viewPlugin(name: string, key: string, label: string) {
  return definePlugin({
    name,
    setup(ctx) {
      ctx.contributions.add(VIEWS, key, { id: key, label });
    },
  });
}

function artifact(
  platform: Platform<string>,
  name: string,
  version: string,
  reference: string,
): Artifact<string> {
  return platform.catalog.add({
    revision: reference,
    manifest: { name, version, activation: ["startup"] },
    reference,
  });
}

export async function hmrModuleGraph(): Promise<ExampleResult> {
  let views!: ContributionView<View>;
  const snapshots: string[] = [];
  const observer = definePlugin({
    name: "examples.hmr-module-graph.observer",
    requires: { views: VIEWS },
    setup(ctx) {
      views = ctx.deps.views;
      const capture = () => {
        snapshots.push(
          [...ctx.deps.views.get().values()]
            .map((view) => view.label)
            .sort()
            .join("+"),
        );
      };
      ctx.deps.views.subscribe(capture);
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
  const host = createHost({
    name: "hmr-module-graph-example",
    installations: [{ id: "observer", plugin: observer }],
  });
  await host.start();
  const platform = createPlatform({
    id: "workbench-extensions",
    host,
    apiVersion: "1.0.0",
    loader: new MemoryLoader<string>(modules),
  });

  const registrations = new Map<string, Registration<string>>();
  for (const [name, reference] of [
    [OUTLINE, "outline-v1"],
    [SEARCH, "search-v1"],
    [THEME, "theme-v1"],
  ] as const) {
    registrations.set(name, await platform.select(artifact(platform, name, "1.0.0", reference)));
  }
  await platform.trigger("startup");
  const before = [...views.get().values()]
    .map((view) => view.label)
    .sort()
    .join(", ");

  const graph = new ModuleGraph([
    { id: "shared/icons.ts", imports: [] },
    { id: "outline/entry.ts", imports: ["shared/icons.ts"], registration: OUTLINE },
    { id: "search/query.ts", imports: ["shared/icons.ts"] },
    { id: "search/entry.ts", imports: ["search/query.ts"], registration: SEARCH },
    { id: "theme/entry.ts", imports: [], registration: THEME },
  ]);
  const invalidation = graph.invalidate(["shared/icons.ts"]);
  const replacements = new Map<string, Artifact<string>>([
    [OUTLINE, artifact(platform, OUTLINE, "2.0.0", "outline-v2")],
    [SEARCH, artifact(platform, SEARCH, "2.0.0", "search-v2")],
    [THEME, artifact(platform, THEME, "2.0.0", "theme-v2")],
  ]);
  const targets: Registration<string>[] = [];
  for (const name of invalidation.registrations) {
    const registration = registrations.get(name);
    const replacement = replacements.get(name);
    if (!registration || !replacement) {
      throw new TypeError(`HMR plan is incomplete for Registration '${name}'`);
    }
    targets.push(await platform.select(replacement));
  }
  snapshots.length = 0;
  await platform.activate(targets);

  const after = [...views.get().values()]
    .map((view) => view.label)
    .sort()
    .join(", ");
  const publishedSnapshots = [...snapshots];

  await platform[Symbol.asyncDispose]();
  await host.stop();

  return exampleResult({
    id: "12",
    stage: "applications",
    title: "Module-graph invalidation compiled into atomic multi-Registration HMR",
    introduces: ["module-graph", "invalidation-closure", "multi-registration-hmr"],
    facts: [
      `Before invalidation the application observed ${before}.`,
      `Changing ${invalidation.changed.join(", ")} invalidated ${invalidation.modules.join(" → ")} by walking importers.`,
      `Affected Registrations were ${invalidation.registrations.join(", ")}; the unrelated theme was excluded rather than restarted.`,
      `One Core Plan published ${after}.`,
      `The observer saw ${publishedSnapshots.length} committed snapshot for two Registration updates: ${publishedSnapshots.join(", ")} — never a half-updated workbench.`,
      "The graph came from a watcher/bundler adapter; this example owns neither file watching nor the module cache.",
    ],
  });
}
