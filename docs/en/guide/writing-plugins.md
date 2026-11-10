# Writing plugins

`definePlugin` accepts `name`, an optional Standard Schema `configuration`, `requires`, `provides` and `setup`. The setup result must match the declared provisions. Configuration is the second argument of `setup(context, configuration)`. An immutable Plugin returned by `definePlugin` can be reused across Installations. The same copy of Core reuses that captured declaration. Passing a mutable declaration captures its fields anew.

`requires` and `provides` are the sole source of dependency and provision declarations. A `setup` parameter annotation or return value cannot invent a missing declaration. Explicit `Plugin<...>` annotations follow the same rules as `definePlugin`: nonempty mappings require the corresponding field. Aliases must be finite, definite, required string keys. Declare an optional Service with `requires: { cache: optional(CACHE) }`; the `cache` alias itself still exists.

Establish the authoring contract with `definePlugin` or an explicit `Plugin<...>` annotation before passing a declaration to `createHost`, `change.install` or a replacement. Unchecked raw objects are rejected. After spreading a Plugin and changing its requirements, provisions, schema or setup, call `definePlugin` again to check the complete composition; the old proof cannot authorize extra aliases or a missing transformation schema. Loaders accepting unknown modules use `capturePluginDeclaration` from `dougong/advanced`, which returns an explicitly erased `AnyPlugin`.

An independently selected `provides` union and setup result can choose different branches. The authoring boundary also rejects optional aliases, open index signatures and a union of Service tokens within one alias. For a dynamic choice, define each complete Plugin before selecting between them. To share behavior, extract the common business capability and compose it into each Plugin.

Without a schema, configuration input passes directly to `setup`, so its type must be assignable to the output type. A typical schema-free Plugin declares one configuration type, such as `definePlugin<{ port: number }>(...)`. A transformation such as string input to number output requires an actual Standard Schema; type parameters cannot create that transformation. The schema input determines installation configuration, and its output determines the second `setup` parameter.

Validation results follow Standard Schema's structural protocol: result, Issue and PathSegment members may be inherited or exposed through accessors, and Core captures each protocol member once when needed. Functions carrying the required fields can implement these protocols without being called. Dense `issues` and `path` arrays are captured by index; unrelated metadata is neither read nor retained. Non-`undefined` `issues` rejects configuration; a successful `value` then passes through immutable data capture and must still satisfy the plain-data constraints.

```ts
const COMMANDS = extensionPoint<{ title: string; run(): Promise<string> }>("editor/commands");
const SAVED = event<{ file: string }>("editor/saved");

const editor = definePlugin({
  name: "editor.main",
  requires: { storage: STORAGE, commands: COMMANDS },
  setup({ dependencies, lifetime, events, contributions }) {
    const session = lifetime.child("session");
    session.defer(() => closeSession());
    events.on(SAVED, ({ file }) => markSaved(file));
    contributions.add(COMMANDS, "save", {
      title: "Save",
      run: () => dependencies.storage.save(),
    });
  },
});
```

Register ownership as resources are acquired. Pass standard resources to `lifetime.use(resource)`, cleanup functions to `lifetime.defer(cleanup)`, and asynchronous standard-resource factories to `lifetime.acquire(factory)`. Consume declared dependencies through `context.dependencies.alias` so the assembly graph captures real dependencies.

Listeners and contributions belong to the current Instance's Lifetime by default. Pass `{ lifetime: child }` to assign a child owner. The options must be a plain data record. Unknown fields and accessors are rejected before registration. Candidate Instances can register both, but neither becomes externally visible until the entire execution commits. Calling `events.emit` during candidate setup fails. Emit from business operations after publication. Between Host transitions, adding or removing a contribution updates its collection and the owning Lifetime's publication count before either view notifies subscribers.

Event listeners can return synchronously or return a Promise. `events.emit` skips listeners whose Lifetime has sealed entry, waits for every invoked listener and rejects with their aggregated failures. Each invocation borrows the listener's Lifetime until completion, so asynchronous handling stays owned. Use `lifetime.spawn` for work that should continue independently of this broadcast; its Task owns background error reporting. Register interruptions required for shutdown with `lifetime.interrupt`.

Configuration is data: ordinary records, arrays, strings, finite numbers, booleans and null. Capture rejects accessors, unusual prototypes, cycles, functions, symbols and sparse arrays. Validator output is captured again. A schema executes once during planning; applying consumes the validated result already in the Plan.

## Describing declarations for documentation and agents

```ts
const description = describePlugin(plugin);
const serialized = JSON.stringify(description);
```

`describePlugin` reads aliases and contract identities directly from requires/provides. Example 05 produces JSON before the first setup call and explicitly reports unavailable JSON Schema for a validator that only implements validate. Schemas implementing Standard JSON Schema 1.1 can export input/output JSON Schema without invoking validation or setup. Generate descriptions from trusted local declarations or at build time; importing external code still requires Platform admission.
