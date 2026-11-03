import { expect, it, vi } from "vitest";
import { createHost } from "dougong";
import { createPlatform, MemoryLoader } from "../src";
import { emptyPlugin, nextTurn, select } from "./fixtures";

const promiseDecorations = ["ordinary", "undefined", "throwing", "fake"] as const;
type PromiseDecoration = (typeof promiseDecorations)[number];

// Promise-returning callbacks stay unmocked because Vitest also observes mock Promise results.
it.each(promiseDecorations)(
  "observes a Platform logger rejection with %s public then without changing its commit",
  async (decoration) => {
    const pending = pendingNativeResult(decoration);
    const observerFailure = new Error("Platform observer failed");
    const sinkFailure = new Error("Platform logger failed");
    const logError = vi.fn<(error: unknown) => void>();
    const host = createHost();
    const platform = createPlatform({
      id: "reporter",
      host,
      apiVersion: "1.0.0",
      loader: new MemoryLoader(new Map([["sample", { default: emptyPlugin("sample") }]])),
      logger: {
        debug() {},
        info() {},
        warn() {},
        error(error: unknown) {
          logError(error);
          return pending.promise;
        },
      },
    });
    const registration = await select(platform, "sample", "sample");
    await host.start();
    const observer = vi.fn<() => void>(() => {
      throw observerFailure;
    });
    const subscription = platform.diagnostics.subscribe(observer);
    try {
      const result = await platform.activate([registration]);
      subscription[Symbol.dispose]();
      const revision = host.stateRevision;
      const reports = observer.mock.calls.length;
      expect(reports).toBeGreaterThan(0);
      expect(result).toEqual({
        stateRevision: revision,
        affectedInstallations: [registration.installation!.id],
      });
      expect(logError).toHaveBeenCalledTimes(reports);
      expect(logError.mock.calls).toEqual(Array.from({ length: reports }, () => [observerFailure]));

      pending.reject(sinkFailure);
      await nextTurn();

      expect(logError).toHaveBeenCalledTimes(reports);
      expect(pending.publicThen).not.toHaveBeenCalled();
      expect(host.stateRevision).toBe(revision);
      expect(registration.status).toBe("installed");
    } finally {
      subscription[Symbol.dispose]();
      await platform[Symbol.asyncDispose]();
      await host.stop();
    }
  },
);

it.each(promiseDecorations)(
  "observes Core reporter and terminal logger rejections with %s public then after a Platform commit",
  async (decoration) => {
    const reporting = pendingNativeResult(decoration);
    const logging = pendingNativeResult(decoration);
    const observerFailure = new Error("Core observer failed");
    const reporterFailure = new Error("Core reporter failed");
    const sinkFailure = new Error("Core logger failed");
    const reportError = vi.fn<(error: unknown) => void>();
    const logError = vi.fn<(error: unknown) => void>();
    const host = createHost({
      onError(error) {
        reportError(error);
        return reporting.promise;
      },
      logger: {
        debug() {},
        info() {},
        warn() {},
        error(error: unknown) {
          logError(error);
          return logging.promise;
        },
      },
    });
    const platform = createPlatform({
      id: "reporter",
      host,
      apiVersion: "1.0.0",
      loader: new MemoryLoader(new Map([["sample", { default: emptyPlugin("sample") }]])),
    });
    const registration = await select(platform, "sample", "sample");
    await host.start();
    const observer = vi.fn<() => void>(() => {
      throw observerFailure;
    });
    const subscription = host.diagnostics.subscribe(observer);
    try {
      const result = await platform.activate([registration]);
      subscription[Symbol.dispose]();
      const revision = host.stateRevision;
      const reports = observer.mock.calls.length;
      expect(reports).toBeGreaterThan(0);
      expect(result).toEqual({
        stateRevision: revision,
        affectedInstallations: [registration.installation!.id],
      });
      expect(reportError).toHaveBeenCalledTimes(reports);
      expect(reportError.mock.calls).toEqual(
        Array.from({ length: reports }, () => [observerFailure]),
      );
      expect(logError).not.toHaveBeenCalled();

      reporting.reject(reporterFailure);
      await nextTurn();

      expect(logError).toHaveBeenCalledTimes(reports);
      for (const [failure] of logError.mock.calls) {
        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure).toMatchObject({ errors: [observerFailure, reporterFailure] });
      }

      logging.reject(sinkFailure);
      await nextTurn();

      expect(reportError).toHaveBeenCalledTimes(reports);
      expect(logError).toHaveBeenCalledTimes(reports);
      expect(reporting.publicThen).not.toHaveBeenCalled();
      expect(logging.publicThen).not.toHaveBeenCalled();
      expect(host.stateRevision).toBe(revision);
      expect(registration.status).toBe("installed");
    } finally {
      subscription[Symbol.dispose]();
      await platform[Symbol.asyncDispose]();
      await host.stop();
    }
  },
);

function pendingNativeResult(decoration: PromiseDecoration) {
  const pending = Promise.withResolvers<void>();
  const publicThen = vi.fn<(fulfilled?: (value: undefined) => void) => void>((fulfilled) => {
    if (decoration === "throwing") throw new Error("Public then must not be read");
    fulfilled?.(undefined);
  });
  if (decoration === "undefined") {
    // oxlint-disable-next-line unicorn/no-thenable -- A Proxy would lose the native Promise brand required by this regression.
    Object.defineProperty(pending.promise, "then", { value: undefined });
  } else if (decoration === "throwing") {
    // oxlint-disable-next-line unicorn/no-thenable -- A Proxy would lose the native Promise brand required by this regression.
    Object.defineProperty(pending.promise, "then", { get: publicThen });
  } else if (decoration === "fake") {
    // oxlint-disable-next-line unicorn/no-thenable -- A Proxy would lose the native Promise brand required by this regression.
    Object.defineProperty(pending.promise, "then", { value: publicThen });
  }
  return { ...pending, publicThen };
}
