import { createResourceAuthority, createHost, definePlugin, service, type Service } from "dougong";

const resourceAuthority = createResourceAuthority();

const maximumTimerDelayMilliseconds = 2_147_483_647;

export interface StartupBenchmark {
  readonly plugins: number;
  readonly delayMilliseconds: number;
  readonly independentMilliseconds: number;
  readonly chainedMilliseconds: number;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function measure(operation: () => Promise<unknown>) {
  const started = performance.now();
  await operation();
  return performance.now() - started;
}

async function measureIndependent(plugins: number, delayMilliseconds: number) {
  const host = createHost({ resourceAuthority, name: "benchmark-independent" });
  const initial = host.change();
  for (let index = 0; index < plugins; index++) {
    initial.install(
      definePlugin({
        name: `examples.benchmark.independent-${index}`,
        async setup() {
          await delay(delayMilliseconds);
        },
      }),
      { id: `independent-${index}` },
    );
  }
  await host.apply(await host.plan(initial));
  const elapsed = await measure(() => host.start());
  await host.stop();
  return elapsed;
}

function link(index: number): Service<number> {
  return service<number>(`examples/benchmark/link-${index}`);
}

async function measureChained(plugins: number, delayMilliseconds: number) {
  const host = createHost({ resourceAuthority, name: "benchmark-chained" });
  const initial = host.change();
  initial.install(
    definePlugin({
      name: "examples.benchmark.link-0",
      provides: { value: link(0) },
      async setup() {
        await delay(delayMilliseconds);
        return { value: 0 };
      },
    }),
    { id: "link-0" },
  );
  for (let index = 1; index < plugins; index++) {
    const previous = link(index - 1);
    const current = link(index);
    initial.install(
      definePlugin({
        name: `examples.benchmark.link-${index}`,
        requires: { previous },
        provides: { value: current },
        async setup(context) {
          await delay(delayMilliseconds);
          return { value: context.dependencies.previous + 1 };
        },
      }),
      { id: `link-${index}` },
    );
  }
  await host.apply(await host.plan(initial));
  const elapsed = await measure(() => host.start());
  await host.stop();
  return elapsed;
}

export async function benchmarkStartup(
  plugins = 20,
  delayMilliseconds = 20,
): Promise<StartupBenchmark> {
  if (!Number.isInteger(plugins) || plugins < 1) {
    throw new TypeError("Plugin count must be a positive integer");
  }
  if (
    !Number.isInteger(delayMilliseconds) ||
    delayMilliseconds < 1 ||
    delayMilliseconds > maximumTimerDelayMilliseconds
  ) {
    throw new TypeError(
      `Delay must be an integer between 1 and ${maximumTimerDelayMilliseconds} milliseconds`,
    );
  }
  return Object.freeze({
    plugins,
    delayMilliseconds,
    independentMilliseconds: await measureIndependent(plugins, delayMilliseconds),
    chainedMilliseconds: await measureChained(plugins, delayMilliseconds),
  });
}
