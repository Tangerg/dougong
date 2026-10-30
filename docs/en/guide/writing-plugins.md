# Writing plugins

`definePlugin` accepts `name`, an optional Standard Schema `config`, `requires`, `provides` and `setup`. The setup result must match the declared provisions. Configuration is the second argument of `setup(ctx, config)`.

```ts
const COMMANDS = extensionPoint<{ title: string; run(): Promise<string> }>("editor/commands");
const SAVED = event<{ file: string }>("editor/saved");

const editor = definePlugin({
  name: "editor.main",
  requires: { storage: STORAGE, commands: COMMANDS },
  setup({ deps, lifetime, events, contributions }) {
    const session = lifetime.child("session");
    session.defer(() => closeSession());
    events.on(SAVED, ({ file }) => markSaved(file));
    contributions.add(COMMANDS, "save", {
      title: "Save",
      run: () => deps.storage.save(),
    });
  },
});
```

Register ownership as resources are acquired. Pass standard resources to `lifetime.use(resource)`, cleanup functions to `lifetime.defer(fn)`, and asynchronous standard-resource factories to `lifetime.acquire(factory)`. Consume declared dependencies through `ctx.deps.alias` so the assembly graph captures real dependencies.

Listeners and contributions belong to the current Instance's Lifetime by default. Pass `{ lifetime: child }` to assign a child owner. Candidate Instances can register both, but neither becomes externally visible until the entire execution commits. Calling `events.emit` during candidate setup fails; emit from business operations that run after publication.

Events accept synchronous listeners. Use `lifetime.spawn` for asynchronous background work; the resulting Task owns error reporting. Register prerequisites for shutting down with `lifetime.interrupt`. A listener returning a Promise does not create an implicit waiting protocol.

Configuration is data: ordinary records, arrays, strings, finite numbers, booleans and null. Capture rejects accessors, unusual prototypes, cycles, functions, symbols and sparse arrays. Validator output is captured again. A schema executes once during planning; applying consumes the validated result already in the Plan.

## Describing declarations for documentation and agents

```ts
const description = describePlugin(plugin);
const serialized = JSON.stringify(description);
```

`describePlugin` reads aliases and contract identities directly from requires/provides. Example 05 produces JSON before the first setup call and explicitly reports unavailable JSON Schema for a validator that only implements validate. Schemas implementing Standard JSON Schema 1.1 can export input/output JSON Schema without invoking validation or setup. Generate descriptions from trusted local declarations or at build time; importing external code still requires Platform admission.
