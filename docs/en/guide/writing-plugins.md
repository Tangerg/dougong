# Writing plugins

`definePlugin` accepts `name`, an optional Standard Schema `configuration`, `requires`, `provides` and `setup`. The setup result must match the declared provisions. Configuration is the second argument of `setup(context, configuration)`. An immutable Plugin returned by `definePlugin` can be reused across Installations. The same copy of Core reuses that captured declaration. Passing a mutable declaration captures its fields anew.

Validation results follow Standard Schema's structural protocol: `issues` and `value` may be inherited members or accessors, and Core captures each protocol member once when needed. Non-`undefined` `issues` rejects configuration; a successful `value` then passes through immutable data capture. Accessors may expose the result protocol, while the configuration value itself must still satisfy the plain-data constraints.

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
