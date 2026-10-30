# Application code

Application and agent callers consume the current generation through stable contracts. `host.use` acquires a borrow synchronously and releases it after the callback's complete result settles. Transitions reject new borrows and join work that already started.

```ts
const answer = await host.use(SEARCH, async (search) => {
  return await search.query("Dougong");
});
```

Do not save the service reference in a long-lived global from inside the callback. TypeScript cannot prevent a reference escaping; the API guarantees lifetime ownership for the callback's duration.

Borrow the owner when invoking executable contributions:

```ts
const commands = host.contributions(COMMANDS);
const id = commands.get().keys().next().value;
if (id !== undefined) {
  await commands.use(id, (command) => command.run());
}
```

`get()` returns an immutable collection snapshot for enumeration and rendering. `use` is the execution boundary; reading a snapshot does not grant indefinite execution authority.

`host.inspect()` and `host.diagnostics.get()` project the same facts. Subscriptions do not replay immediately; notifications carry no payload, so read through `get()` in the callback. Unsubscribe with `subscription[Symbol.dispose]()`. Bounded `RecordedFailure` diagnostics avoid retaining arbitrary plugin resource graphs through exceptions.

CLI, UI and agent callers share `change → plan → apply`. Present the Plan's bindings, impact, order and execution guarantees before applying that exact Plan. If state changed, plan again.
