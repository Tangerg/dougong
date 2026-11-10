import {
  createResourceAuthority,
  asyncDisposeSymbol,
  createHost,
  definePlugin,
  service,
} from "dougong";
import { onAbort } from "dougong/advanced";
import { computed, disposeSymbol, observe, signal, type Readable } from "@dougongjs/reactive";
import { createPlatform, MemoryLoader } from "@dougongjs/platform";
import { verifyObservationBoundary } from "./observation-boundary.mjs";

const resourceAuthority = createResourceAuthority();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function verifyCancellation() {
  const controller = new AbortController();
  const reasons: unknown[] = [];
  const reason = { operation: "browser cancellation" };
  Object.defineProperties(controller.signal, {
    aborted: { value: true },
    reason: { value: "shadowed" },
  });
  const detach = onAbort(controller.signal, (value) => reasons.push(value));
  controller.signal.dispatchEvent(new Event("abort"));
  assert(Object.is(reasons.length, 0), "Synthetic abort or shadow state cancelled the consumer");
  controller.abort(reason);
  assert(
    reasons.length === 1 && reasons[0] === reason,
    "Shadow state changed native cancellation or its reason",
  );
  detach();

  const stopped = new AbortController();
  stopped.signal.addEventListener("abort", (event) => event.stopImmediatePropagation());
  const delivered: unknown[] = [];
  const release = onAbort(stopped.signal, (value) => delivered.push(value));
  stopped.abort(reason);
  assert(
    delivered.length === 1 && delivered[0] === reason,
    "Stopped event propagation hid native cancellation or changed its reason",
  );
  release();

  const source = new AbortController();
  let detachedCalls = 0;
  const remove = onAbort(source.signal, () => detachedCalls++);
  const retained: unknown[] = [];
  const retain = onAbort(source.signal, (value) => retained.push(value));
  remove();
  source.abort(reason);
  assert(
    detachedCalls === 0 && retained.length === 1 && retained[0] === reason,
    "Detaching an abort observation changed another observation's ownership",
  );
  retain();
}

function verifySubscriptions() {
  const source = signal(1);
  const doubled = computed(() => source.get() * 2);
  const values: number[] = [];
  const subscription = doubled.subscribe(() => values.push(doubled.get()));
  source.set(2);
  subscription[disposeSymbol]();
  source.set(3);
  assert(
    values.length === 1 && values[0] === 4 && doubled.get() === 6,
    "Browser subscriptions failed to update or detach through the disposal protocol",
  );
}

function assertComputedRejectsAsync(value: unknown) {
  let failure: unknown;
  try {
    computed(() => value).get();
  } catch (error) {
    failure = error;
  }
  assert(
    failure instanceof TypeError &&
      failure.message === "Computed signal calculations must be synchronous",
    "An asynchronous result bypassed the browser computed boundary",
  );
}

async function verifySynchronousResults() {
  const iframe = document.createElement("iframe");
  document.body.append(iframe);
  try {
    const foreignWindow = iframe.contentWindow;
    assert(foreignWindow, "Browser consumer could not create a separate Promise realm");
    for (const throwing of [false, true]) {
      const pending = Promise.withResolvers<void>();
      let reads = 0;
      const thenDescriptor = throwing
        ? {
            get() {
              reads++;
              throw new Error("Public then cannot replace native Promise settlement");
            },
          }
        : { value: undefined };
      // oxlint-disable-next-line unicorn/no-thenable -- A Proxy would lose the native brand required by this regression.
      Object.defineProperty(pending.promise, "then", thenDescriptor);
      assertComputedRejectsAsync(pending.promise);
      assert(reads === 0, "A local native result exposed its decorated public then getter");
      pending.reject(new Error("Decorated native Promise rejection"));
    }

    const foreignPromise = foreignWindow.window.Promise;
    const ordinary = foreignPromise.withResolvers<void>();
    assertComputedRejectsAsync(ordinary.promise);
    ordinary.reject(new Error("Ordinary foreign Promise rejection"));

    const verifyStructuralResults: Array<() => void> = [];
    for (const tagged of [false, true]) {
      const pending = foreignPromise.withResolvers<void>();
      let result: PromiseLike<void> = pending.promise;
      if (tagged) {
        result = {
          // oxlint-disable-next-line unicorn/no-thenable -- A structural Promise forwards the same settlement protocol.
          then(onFulfilled, onRejected) {
            return pending.promise.then(onFulfilled, onRejected);
          },
        };
        Object.setPrototypeOf(result, { [Symbol.toStringTag]: "Promise" });
      }
      const then = result.then;
      const rejection = new Error("Structural foreign Promise rejection");
      let reads = 0;
      let calls = 0;
      let receiver: unknown;
      let observedRejection: unknown;
      // oxlint-disable-next-line unicorn/no-thenable -- The forwarding getter keeps the foreign protocol conforming.
      Object.defineProperty(result, "then", {
        get() {
          reads++;
          return function (
            this: PromiseLike<void>,
            ...callbacks: Parameters<PromiseLike<void>["then"]>
          ) {
            calls++;
            receiver = this;
            const [onFulfilled, onRejected] = callbacks;
            assert(
              typeof onRejected === "function",
              "A structural result has no rejection observer",
            );
            return Reflect.apply(then, this, [
              onFulfilled,
              (reason: unknown) => {
                observedRejection = reason;
                return onRejected(reason);
              },
            ]);
          };
        },
      });
      assertComputedRejectsAsync(result);
      assert(reads === 1 && calls === 0, "Structural then was not captured once before invocation");
      pending.reject(rejection);
      verifyStructuralResults.push(() => {
        assert(
          reads === 1 && calls === 1 && receiver === result && observedRejection === rejection,
          "The browser consumer changed structural settlement, its receiver, or its capture count",
        );
      });
    }
    // Both realms must survive the rejection-reporting task so pageerror can expose a leak.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    for (const verify of verifyStructuralResults) verify();
  } finally {
    iframe.remove();
  }
}

async function verifyResources() {
  const values = signal(1);
  const observations: number[] = [];
  const released: string[] = [];
  const failures: unknown[] = [];
  const releaseStarted = Promise.withResolvers<void>();
  const allowRelease = Promise.withResolvers<void>();
  const replaced = Promise.withResolvers<void>();
  const observedValues: Readable<number> = {
    get: () => values.get(),
    subscribe(listener) {
      const subscription = values.subscribe(listener);
      return {
        [disposeSymbol]() {
          subscription[disposeSymbol]();
          released.push("subscription");
        },
      };
    },
  };
  const owner = definePlugin({
    name: "browser.owner",
    setup({ lifetime }) {
      lifetime.signal.addEventListener("abort", (event) => event.stopImmediatePropagation());
      lifetime.defer(() => released.push("owner"));
      observe(lifetime, observedValues, (value, child) => {
        observations.push(value);
        child.defer(async () => {
          if (value === 1) {
            releaseStarted.resolve();
            await allowRelease.promise;
          }
          released.push(`observation:${value}`);
        });
        if (value === 2) replaced.resolve();
      });
    },
  });
  const host = createHost({
    resourceAuthority,
    installations: [{ id: "owner", plugin: owner }],
    onError(error) {
      failures.push(error);
    },
  });
  try {
    await host.start();
    values.set(2);
    await releaseStarted.promise;
    assert(observations.length === 1, "Observation replaced an owner before cleanup completed");
    allowRelease.resolve();
    await replaced.promise;
    assert(
      Object.is(observations.length, 2) && released[0] === "observation:1",
      "Observation replaced its resource before the previous owner finished",
    );

    const counterService = service<{ value: number }>("browser/counter");
    const counter = definePlugin({
      name: "browser.counter",
      provides: { counter: counterService },
      setup({ lifetime }) {
        lifetime.defer(() => released.push("counter"));
        return { counter: { value: 7 } };
      },
    });
    const reference = "counter-module";
    const platform = createPlatform({
      id: "browser-delivery",
      host,
      apiVersion: "1.0.0",
      loader: new MemoryLoader(new Map([[reference, { default: counter }]])),
    });
    try {
      const artifact = platform.catalog.add({
        revision: "counter-build-1",
        manifest: { name: counter.name, version: "1.0.0" },
        reference,
      });
      const [registration] = await platform.select([artifact]);
      await platform.activate([registration]);
      assert(
        registration.activeOrigin?.revision === artifact.revision &&
          (await host.use(counterService, (counter) => counter.value)).value === 7,
        "Browser activation separated the committed service from its artifact origin",
      );
    } finally {
      await platform[asyncDisposeSymbol]();
    }
    assert(
      released.filter((item) => item === "counter").length === 1,
      "Platform failed to release its installation exactly once",
    );
  } finally {
    allowRelease.resolve();
    await host[asyncDisposeSymbol]();
  }
  values.set(3);
  assert(
    Object.is(observations.length, 2) &&
      released.filter((item) => item === "subscription").length === 1 &&
      released.filter((item) => item === "observation:1").length === 1 &&
      released.filter((item) => item === "observation:2").length === 1 &&
      released.filter((item) => item === "owner").length === 1,
    "Host shutdown did not detach observation and release its owned resources exactly once",
  );
  if (failures.length) throw new AggregateError(failures, "Browser Host reported failures");
}

export async function verifyBrowserConsumer() {
  verifyCancellation();
  verifySubscriptions();
  await verifySynchronousResults();
  await verifyResources();
  await verifyObservationBoundary();
}
