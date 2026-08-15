import { createHost, definePlugin, service, type Service } from "dougong";

export interface StartupBenchmark {
  readonly plugins: number;
  readonly delayMilliseconds: number;
  readonly independentMilliseconds: number;
  readonly chainedMilliseconds: number;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function measure(operation: () => Promise<void>) {
  const started = performance.now();
  await operation();
  return performance.now() - started;
}

async function measureIndependent(plugins: number, delayMilliseconds: number) {
  const host = createHost({ name: "benchmark-independent" });
  for (let index = 0; index < plugins; index++) {
    host.install(
      definePlugin({
        name: `examples.benchmark.independent-${index}`,
        async setup() {
          await delay(delayMilliseconds);
        },
      }),
    );
  }
  const elapsed = await measure(() => host.start());
  await host.stop();
  return elapsed;
}

function link(index: number): Service<number> {
  return service<number>(`examples/benchmark/link-${index}`);
}

async function measureChained(plugins: number, delayMilliseconds: number) {
  const host = createHost({ name: "benchmark-chained" });
  host.install(
    definePlugin({
      name: "examples.benchmark.link-0",
      provides: { value: link(0) },
      async setup() {
        await delay(delayMilliseconds);
        return { value: 0 };
      },
    }),
  );
  for (let index = 1; index < plugins; index++) {
    const previous = link(index - 1);
    const current = link(index);
    host.install(
      definePlugin({
        name: `examples.benchmark.link-${index}`,
        requires: { previous },
        provides: { value: current },
        async setup(ctx) {
          await delay(delayMilliseconds);
          return { value: ctx.previous + 1 };
        },
      }),
    );
  }
  const elapsed = await measure(() => host.start());
  await host.stop();
  return elapsed;
}

/** Informational benchmark; behavioral tests, not wall-clock thresholds, gate CI. */
export async function benchmarkStartup(
  plugins = 20,
  delayMilliseconds = 20,
): Promise<StartupBenchmark> {
  if (!Number.isInteger(plugins) || plugins < 1) {
    throw new TypeError("Plugin count must be a positive integer");
  }
  if (!Number.isFinite(delayMilliseconds) || delayMilliseconds < 0) {
    throw new TypeError("Delay must be a non-negative finite number");
  }
  return Object.freeze({
    plugins,
    delayMilliseconds,
    independentMilliseconds: await measureIndependent(plugins, delayMilliseconds),
    chainedMilliseconds: await measureChained(plugins, delayMilliseconds),
  });
}
