import assert from "node:assert/strict";

// Native keys are nonconfigurable in Node. Model a runtime without them before loading any package.
const masked = Symbol.bind(undefined);
const descriptors = Object.getOwnPropertyDescriptors(Symbol);
delete descriptors.dispose;
delete descriptors.asyncDispose;
Object.defineProperties(masked, descriptors);
globalThis.Symbol = masked;

const { bridge, signal, disposeSymbol, asyncDisposeSymbol } = await import("@dougongjs/reactive");
const value = signal(0);
let updates = 0;
const listener = value.subscribe(() => updates++);
value.set(1);
listener[disposeSymbol]();
value.set(2);
assert.equal(updates, 1);

const core = await import("dougong");
const { createHost, definePlugin } = core;
assert.equal(core.disposeSymbol, disposeSymbol);
assert.equal(core.asyncDisposeSymbol, asyncDisposeSymbol);
const { onAbort } = await import("dougong/advanced");
const controller = new AbortController();
let called = 0;
const detach = onAbort(controller.signal, () => called++);
detach();
controller.abort();
assert.equal(called, 0);
const { createPlatform, MemoryLoader } = await import("@dougongjs/platform");
assert.equal(disposeSymbol, Symbol.for("Symbol.dispose"));
assert.equal(asyncDisposeSymbol, Symbol.for("Symbol.asyncDispose"));

const released = [];
let child;
let readable;
const host = createHost({
  installations: [
    {
      id: "owner",
      plugin: definePlugin({
        name: "owner",
        setup({ lifetime }) {
          lifetime.use({
            [disposeSymbol]() {
              released.push("root");
            },
          });
          child = lifetime.child("child");
          child.defer(() => released.push("child"));
          readable = bridge(child, signal(7));
        },
      }),
    },
  ],
});
const subscription = host.diagnostics.subscribe(() => {});
const platform = createPlatform({
  id: "fallback",
  host,
  apiVersion: "1.0.0",
  loader: new MemoryLoader(new Map()),
});
assert.equal("undefined" in host, false);
assert.equal("undefined" in platform, false);
await host.start();
assert.equal(readable.get(), 7);
await child[asyncDisposeSymbol]();
assert.throws(() => readable.get(), /disposed/);
subscription[disposeSymbol]();
await platform[asyncDisposeSymbol]();
assert.equal(platform.diagnostics.get().status, "disposed");
await host[asyncDisposeSymbol]();
assert.equal(host.status, "stopped");
assert.deepEqual(released, ["child", "root"]);
assert.equal("dispose" in Symbol, false);
assert.equal("asyncDispose" in Symbol, false);
console.log(
  "Packed consumer OK: registered disposal symbols across all packages without native keys",
);
