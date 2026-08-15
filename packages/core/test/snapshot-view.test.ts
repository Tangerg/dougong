import { describe, expect, it, vi } from "vitest";
import { SnapshotPublisher } from "../src/index";

const RELEASE_PASSES = 8;

describe("SnapshotPublisher", () => {
  it("publishes invalidations through one read-only protocol", () => {
    let value = 1;
    const read = vi.fn<() => number>(() => value);
    const report = vi.fn<(error: unknown) => void>();
    const publisher = new SnapshotPublisher(read, report);
    const listener = vi.fn<() => void>();
    const subscription = publisher.view.subscribe(listener);

    expect(Object.keys(publisher)).toEqual(["view"]);
    expect("get" in publisher).toBe(false);
    expect("subscribe" in publisher).toBe(false);
    expect(Object.isFrozen(publisher)).toBe(true);

    expect(publisher.view.get()).toBe(1);
    expect(read).toHaveBeenCalledTimes(1);

    value = 2;
    publisher.invalidate();
    expect(listener).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledTimes(1);
    expect(publisher.view.get()).toBe(2);
    expect(read).toHaveBeenCalledTimes(2);

    subscription.dispose();
    publisher.invalidate();
    expect(listener).toHaveBeenCalledOnce();
    expect(report).not.toHaveBeenCalled();
  });

  it("isolates subscriber failures through the configured error boundary", () => {
    const failure = new Error("subscriber failed");
    const report = vi.fn<(error: unknown) => void>();
    const publisher = new SnapshotPublisher(() => 0, report);
    const succeeding = vi.fn<() => void>();
    publisher.view.subscribe(() => {
      throw failure;
    });
    publisher.view.subscribe(succeeding);

    publisher.invalidate();

    expect(report).toHaveBeenCalledWith(failure);
    expect(succeeding).toHaveBeenCalledOnce();
  });

  it("finishes notification and preserves both failures when error reporting fails", () => {
    const subscriberFailure = new Error("subscriber failed");
    const reporterFailure = new Error("reporter failed");
    const publisher = new SnapshotPublisher(
      () => 0,
      () => {
        throw reporterFailure;
      },
    );
    const succeeding = vi.fn<() => void>();
    publisher.view.subscribe(() => {
      throw subscriberFailure;
    });
    publisher.view.subscribe(succeeding);

    const failure = captureError(() => publisher.invalidate());

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([subscriberFailure, reporterFailure]);
    expect(succeeding).toHaveBeenCalledOnce();
  });

  it("materializes its final snapshot and severs terminal subscriptions", () => {
    let value = 1;
    const publisher = new SnapshotPublisher(
      () => value,
      () => undefined,
    );
    const listener = vi.fn<() => void>();
    const subscription = publisher.view.subscribe(listener);

    value = 2;
    publisher.invalidate();
    publisher.dispose();
    publisher.dispose();

    expect(publisher.view.get()).toBe(2);
    expect(() => publisher.invalidate()).toThrow("Snapshot publisher is disposed");
    expect(() => publisher.view.subscribe(() => undefined)).toThrow(
      "Snapshot publisher is disposed",
    );
    expect(() => subscription.dispose()).not.toThrow();
  });

  it("validates callback boundaries", () => {
    expect(() => new SnapshotPublisher(undefined as never, () => undefined)).toThrow(
      "Snapshot reader must be a function",
    );
    expect(() => new SnapshotPublisher(() => 0, undefined as never)).toThrow(
      "Snapshot error reporter must be a function",
    );
    const publisher = new SnapshotPublisher(
      () => 0,
      () => undefined,
    );
    expect(() => publisher.view.subscribe(undefined as never)).toThrow(
      "Subscriber must be a function",
    );
  });

  it("does not retain callbacks through a terminal view or subscription", async () => {
    const forceGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    if (!forceGc) throw new TypeError("Retention tests require Node.js --expose-gc");

    const fixture = createTerminalPublisherFixture();
    for (
      let pass = 0;
      pass < RELEASE_PASSES && Object.values(fixture.references).some((ref) => ref.deref());
      pass++
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      forceGc();
      forceGc();
    }

    expect(fixture.view.get()).toBe(1);
    expect(() => fixture.subscription.dispose()).not.toThrow();
    expect(
      Object.fromEntries(
        Object.entries(fixture.references).map(([name, ref]) => [name, ref.deref() === undefined]),
      ),
    ).toEqual({ reader: true, reporter: true, listener: true });
  });
});

function createTerminalPublisherFixture() {
  const reader = {};
  const reporter = {};
  const listener = {};
  const publisher = new SnapshotPublisher(
    () => {
      void reader;
      return 1;
    },
    () => void reporter,
  );
  const subscription = publisher.view.subscribe(() => void listener);
  const references = {
    reader: new WeakRef(reader),
    reporter: new WeakRef(reporter),
    listener: new WeakRef(listener),
  };
  publisher.dispose();
  return { view: publisher.view, subscription, references };
}

function captureError(operation: () => void) {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to fail");
}
