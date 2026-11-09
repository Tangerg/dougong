import { describe, expect, it, vi } from "vitest";
import { batchSnapshotNotifications, SnapshotPublisher } from "../src/advanced";

const RELEASE_PASSES = 8;
const NOTIFICATION_CHAIN_LENGTH = 4096;

describe("snapshot notification error boundaries", () => {
  it.each([new Error("operation failed"), undefined])(
    "reports notification failures without replacing the operation failure (%s)",
    (operationFailure) => {
      const subscriberFailure = new Error("subscriber failed");
      const reporterFailure = new Error("reporter failed");
      using publisher = createFailingPublisher(subscriberFailure, reporterFailure);
      const report = vi.fn<(error: unknown) => void>();
      const sibling = vi.fn<() => void>();
      publisher.view.subscribe(sibling);

      const failure = captureError(() =>
        batchSnapshotNotifications(() => {
          publisher.invalidate();
          expect(sibling).not.toHaveBeenCalled();
          throw operationFailure;
        }, report),
      );

      expect(failure).toBe(operationFailure);
      expect(sibling).toHaveBeenCalledOnce();
      expect(report).toHaveBeenCalledOnce();
      const notificationFailure = report.mock.calls[0]![0] as AggregateError;
      expect(notificationFailure).toBeInstanceOf(AggregateError);
      expect(notificationFailure.errors[0]).toBe(subscriberFailure);
      expect(notificationFailure.errors[1]).toBe(reporterFailure);
    },
  );

  it("keeps reader failures at the operation boundary", () => {
    const readerFailure = new Error("reader failed");
    let failRead = false;
    using publisher = new SnapshotPublisher(
      () => {
        if (failRead) throw readerFailure;
        return 0;
      },
      () => undefined,
    );
    const report = vi.fn<(error: unknown) => void>();
    failRead = true;

    const failure = captureError(() =>
      batchSnapshotNotifications(() => {
        publisher.invalidate();
        publisher.view.get();
      }, report),
    );

    failRead = false;
    expect(failure).toBe(readerFailure);
    expect(report).not.toHaveBeenCalled();
    expect(publisher.view.get()).toBe(0);
  });

  it("keeps each nested boundary after its batch returns and inherits an omitted boundary", () => {
    const innerSubscriberFailure = new Error("inner subscriber failed");
    const outerSubscriberFailure = new Error("outer subscriber failed");
    const reporterFailure = new Error("reporter failed");
    using innerPublisher = createFailingPublisher(innerSubscriberFailure, reporterFailure);
    using outerPublisher = createFailingPublisher(outerSubscriberFailure, reporterFailure);
    const reportInner = vi.fn<(error: unknown) => void>();
    const reportOuter = vi.fn<(error: unknown) => void>();

    batchSnapshotNotifications(() => {
      batchSnapshotNotifications(() => innerPublisher.invalidate(), reportInner);
      batchSnapshotNotifications(() => outerPublisher.invalidate());
      expect(reportInner).not.toHaveBeenCalled();
      expect(reportOuter).not.toHaveBeenCalled();
    }, reportOuter);

    expect(reportInner).toHaveBeenCalledExactlyOnceWith(
      new AggregateError(
        [innerSubscriberFailure, reporterFailure],
        "Snapshot error reporting failed",
      ),
    );
    expect(reportOuter).toHaveBeenCalledExactlyOnceWith(
      new AggregateError(
        [outerSubscriberFailure, reporterFailure],
        "Snapshot error reporting failed",
      ),
    );
  });

  it("coalesces one notification without transferring responsibility from the first explicit boundary", () => {
    const subscriberFailure = new Error("subscriber failed");
    const reporterFailure = new Error("reporter failed");
    using publisher = createFailingPublisher(subscriberFailure, reporterFailure);
    const reportFirst = vi.fn<(error: unknown) => void>();
    const reportLater = vi.fn<(error: unknown) => void>();
    const sibling = vi.fn<() => void>();
    publisher.view.subscribe(sibling);

    batchSnapshotNotifications(() => {
      batchSnapshotNotifications(() => publisher.invalidate(), reportFirst);
      batchSnapshotNotifications(() => publisher.invalidate(), reportLater);
    });

    expect(reportFirst).toHaveBeenCalledExactlyOnceWith(
      new AggregateError([subscriberFailure, reporterFailure], "Snapshot error reporting failed"),
    );
    expect(sibling).toHaveBeenCalledOnce();
    expect(reportLater).not.toHaveBeenCalled();
  });

  it("coalesces one notification without assigning an unscoped failure to a later explicit boundary", () => {
    const subscriberFailure = new Error("subscriber failed");
    const reporterFailure = new Error("reporter failed");
    using publisher = createFailingPublisher(subscriberFailure, reporterFailure);
    const reportLater = vi.fn<(error: unknown) => void>();
    const sibling = vi.fn<() => void>();
    publisher.view.subscribe(sibling);

    const failure = captureError(() =>
      batchSnapshotNotifications(() => {
        publisher.invalidate();
        batchSnapshotNotifications(() => publisher.invalidate(), reportLater);
      }),
    ) as AggregateError;

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors[0]).toBe(subscriberFailure);
    expect(failure.errors[1]).toBe(reporterFailure);
    expect(sibling).toHaveBeenCalledOnce();
    expect(reportLater).not.toHaveBeenCalled();
  });

  it("drains notifications raised by subscribers, ordinary reporters, and terminal reporters in order", () => {
    const firstFailure = new Error("first subscriber failed");
    const subscriberReentryFailure = new Error("subscriber reentry failed");
    const reporterReentryFailure = new Error("reporter reentry failed");
    const terminalReentryFailure = new Error("terminal reentry failed");
    const reporterFailure = new Error("reporter failed");
    using subscriberReentry = createFailingPublisher(subscriberReentryFailure, reporterFailure);
    using reporterReentry = createFailingPublisher(reporterReentryFailure, reporterFailure);
    using terminalReentry = createFailingPublisher(terminalReentryFailure, reporterFailure);
    using publisher = new SnapshotPublisher(
      () => 0,
      () => {
        reporterReentry.invalidate();
        throw reporterFailure;
      },
    );
    publisher.view.subscribe(() => {
      subscriberReentry.invalidate();
      throw firstFailure;
    });
    const received: unknown[] = [];
    const report = (failure: unknown) => {
      const notificationFailure = failure as AggregateError;
      expect(notificationFailure.errors[1]).toBe(reporterFailure);
      received.push(notificationFailure.errors[0]);
      if (received.length === 1) terminalReentry.invalidate();
    };

    batchSnapshotNotifications(() => publisher.invalidate(), report);

    expect(received).toEqual([
      firstFailure,
      subscriberReentryFailure,
      reporterReentryFailure,
      terminalReentryFailure,
    ]);
  });

  it("delivers a deep reentrant chain without recursively entering the subscriber", () => {
    const subscriberFailure = new Error("last subscriber failed");
    const reporterFailure = new Error("reporter failed");
    const report = vi.fn<(error: unknown) => void>();
    let notifications = 0;
    using publisher = new SnapshotPublisher(
      () => notifications,
      () => {
        throw reporterFailure;
      },
    );
    publisher.view.subscribe(() => {
      notifications++;
      if (notifications < NOTIFICATION_CHAIN_LENGTH) publisher.invalidate();
      else throw subscriberFailure;
    });

    batchSnapshotNotifications(() => publisher.invalidate(), report);

    expect(notifications).toBe(NOTIFICATION_CHAIN_LENGTH);
    expect(report).toHaveBeenCalledExactlyOnceWith(
      new AggregateError([subscriberFailure, reporterFailure], "Snapshot error reporting failed"),
    );
  });

  it.each(["subscription", "publisher"] as const)(
    "cancels owned notifications when their %s is disposed before delivery",
    (disposed) => {
      const reporterFailure = new Error("reporter failed");
      using publisher = new SnapshotPublisher(
        () => 0,
        () => {
          throw reporterFailure;
        },
      );
      const listener = vi.fn<() => void>(() => {
        throw new Error("subscriber failed");
      });
      using subscription = publisher.view.subscribe(listener);
      const report = vi.fn<(error: unknown) => void>();

      batchSnapshotNotifications(() => {
        batchSnapshotNotifications(() => publisher.invalidate(), report);
        if (disposed === "subscription") subscription[Symbol.dispose]();
        else publisher[Symbol.dispose]();
      });

      expect(listener).not.toHaveBeenCalled();
      expect(report).not.toHaveBeenCalled();
    },
  );

  it.each(["delivered", "cancelled"] as const)(
    "releases a boundary capture after its notification is %s while the publisher is retained",
    async (outcome) => {
      const forceGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
      if (!forceGc) throw new TypeError("Retention tests require Node.js --expose-gc");
      using publisher = new SnapshotPublisher(
        () => 0,
        () => undefined,
      );
      using subscription = publisher.view.subscribe(() => undefined);
      const reference = exerciseNotificationBoundary(
        publisher,
        outcome === "cancelled" ? () => subscription[Symbol.dispose]() : undefined,
      );

      for (let pass = 0; pass < RELEASE_PASSES && reference.deref(); pass++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        forceGc();
        forceGc();
      }

      expect(reference.deref()).toBeUndefined();
      expect(publisher.view.get()).toBe(0);
    },
  );

  it.each([new Error("terminal reporter failed"), undefined])(
    "reports a failing terminal reporter outside the operation outcome (%s)",
    (boundaryFailure) => {
      const scheduled: VoidFunction[] = [];
      vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
        scheduled.push(callback);
      });
      const subscriberFailure = new Error("subscriber failed");
      const reporterFailure = new Error("reporter failed");
      using publisher = createFailingPublisher(subscriberFailure, reporterFailure);
      const sibling = vi.fn<() => void>();
      publisher.view.subscribe(sibling);

      expect(() =>
        batchSnapshotNotifications(
          () => publisher.invalidate(),
          () => {
            throw boundaryFailure;
          },
        ),
      ).not.toThrow();

      expect(sibling).toHaveBeenCalledOnce();
      expect(scheduled).toHaveLength(1);
      const failure = captureError(scheduled[0]!) as AggregateError;
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.message).toBe("Snapshot notification error boundary failed");
      const notificationFailure = failure.errors[0] as AggregateError;
      expect(notificationFailure.errors[0]).toBe(subscriberFailure);
      expect(notificationFailure.errors[1]).toBe(reporterFailure);
      expect(failure.errors[1]).toBe(boundaryFailure);
    },
  );

  it("rejects a dynamically asynchronous terminal reporter without losing its rejection", async () => {
    const scheduled: VoidFunction[] = [];
    vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
      scheduled.push(callback);
    });
    const subscriberFailure = new Error("subscriber failed");
    const reporterFailure = new Error("reporter failed");
    const rejectedFailure = new Error("asynchronous terminal reporter failed");
    const rejected = Promise.reject(rejectedFailure);
    using publisher = createFailingPublisher(subscriberFailure, reporterFailure);

    expect(() =>
      batchSnapshotNotifications(() => publisher.invalidate(), (() => rejected) as never),
    ).not.toThrow();

    expect(scheduled).toHaveLength(1);
    const failure = captureError(scheduled[0]!) as AggregateError;
    expect(failure).toBeInstanceOf(AggregateError);
    const notificationFailure = failure.errors[0] as AggregateError;
    expect(notificationFailure.errors[0]).toBe(subscriberFailure);
    expect(notificationFailure.errors[1]).toBe(reporterFailure);
    expect(failure.errors[1]).toEqual(
      new TypeError("Snapshot notification error reporters must be synchronous"),
    );
    await expect(rejected).rejects.toBe(rejectedFailure);
  });

  it.each([null, 0, {}])("validates an invalid terminal reporter before effects (%s)", (report) => {
    const operation = vi.fn<() => void>();

    expect(() => batchSnapshotNotifications(operation, report as never)).toThrow(
      "Snapshot notification error reporter must be a function",
    );

    expect(operation).not.toHaveBeenCalled();
  });

  it("does not expose the notification queue through a terminal reporter's receiver", () => {
    using publisher = createFailingPublisher(
      new Error("subscriber failed"),
      new Error("reporter failed"),
    );
    const receivers: unknown[] = [];

    batchSnapshotNotifications(
      () => publisher.invalidate(),
      function (this: unknown) {
        receivers.push(this);
      },
    );

    expect(receivers).toEqual([undefined]);
  });
});

function createFailingPublisher(subscriberFailure: unknown, reporterFailure: unknown) {
  const publisher = new SnapshotPublisher(
    () => 0,
    () => {
      throw reporterFailure;
    },
  );
  publisher.view.subscribe(() => {
    throw subscriberFailure;
  });
  return publisher;
}

function exerciseNotificationBoundary(publisher: SnapshotPublisher<number>, cancel?: () => void) {
  const owner = {};
  batchSnapshotNotifications(() => {
    batchSnapshotNotifications(
      () => publisher.invalidate(),
      () => void owner,
    );
    cancel?.();
  });
  return new WeakRef(owner);
}

function captureError(operation: () => void) {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to fail");
}
