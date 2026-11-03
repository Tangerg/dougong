# Application code

Application and agent callers consume the current generation through stable contracts. `host.use` acquires a borrow synchronously and releases it after the callback's complete result settles. A change that would destroy that generation rejects with [`HOST_BUSY`](../reference/errors.md). Once an admitted transition seals entry, affected generations reject new borrows; unaffected generations can continue serving.

```ts
const { value: answer } = await host.use(SEARCH, async (search) => {
  return await search.query("Dougong");
});
```

`host.use` and contribution `use` return a frozen `{ value }` receipt; destructure it when the result is needed. Failures still reject the Promise, and a receipt does not extend the borrow. Do not save the service reference in a long-lived global from inside the callback. TypeScript cannot prevent a reference escaping; the API guarantees lifetime ownership for the callback's duration.

Borrow the owner when invoking executable contributions:

```ts
const commands = host.contributions(COMMANDS);
const id = commands.get()[0];
if (id !== undefined) {
  await commands.use(id, (command) => command.run());
}
```

`get()` returns a frozen array of owner-qualified IDs in publication order. Holding a snapshot never retains a handler. To migrate code that used `get().values()` or read a map entry, enumerate the IDs and use `const { value: title } = await commands.use(id, command => command.title)` (or project another data field) to render. Borrow the value again when invoking it. `use` borrows the current published entry and returns a rejected Promise if unavailable. Changed or replaced values publish a fresh snapshot even when the IDs are unchanged. While a Host transition is pending, the snapshot stays on the last publication and changed entries are unavailable until published.

`host.diagnostics.get()` is the sole entrypoint for reading a stable Host snapshot. Subscriptions do not replay immediately; notifications carry no payload, so read through `get()` in the callback. Import `disposeSymbol` from `dougong` and call `subscription[disposeSymbol]()` to unsubscribe. Bounded `RecordedFailure` diagnostics avoid retaining arbitrary plugin resource graphs through exceptions.

CLI, UI and agent callers share `change → plan → apply`. Present the Plan's bindings, impact, order and execution guarantees before applying that exact Plan. If state changed, plan again.

`host.change()` returns a frozen staging interface. It grants no access to the underlying operation list, installation records or commit authority. A pending Installation does not hold a Host reference; its handle begins projecting Engine state only when committed.
