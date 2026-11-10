import { createResourceAuthority, asyncDisposeSymbol, createHost, disposeSymbol } from "dougong";
import { batchSnapshotNotifications, SnapshotPublisher } from "dougong/advanced";

const resourceAuthority = createResourceAuthority();

export async function verifyObservationBoundary() {
  const observerFailure = new Error("Packed snapshot observer failed");
  const reporterFailure = new Error("Packed snapshot reporter failed");
  const failures: unknown[] = [];
  const report = (error: unknown) => {
    failures.push(error);
  };
  const publisher = new SnapshotPublisher(
    () => 1,
    () => {
      throw reporterFailure;
    },
  );
  publisher.view.subscribe(() => {
    throw observerFailure;
  });
  const host = createHost({ resourceAuthority, onError: report });
  let observed = false;
  const subscription = host.diagnostics.subscribe(() => {
    if (!observed && host.status === "running") {
      observed = true;
      publisher.invalidate();
    }
  });
  try {
    const receipt = await host.start();
    if (!observed || host.status !== "running" || receipt.stateRevision !== host.stateRevision) {
      throw new Error("Packed observation changed the committed Host outcome");
    }
    if (failures.length !== 1) {
      throw new Error("Packed Core did not report the notification failure exactly once");
    }
    batchSnapshotNotifications(() => publisher.invalidate(), report);
    if (!Object.is(failures.length, 2)) {
      throw new Error("Packed advanced entrypoint lost the explicit notification boundary");
    }
    for (const failure of failures) {
      if (
        !(failure instanceof AggregateError) ||
        failure.errors.length !== 2 ||
        failure.errors[0] !== observerFailure ||
        failure.errors[1] !== reporterFailure
      ) {
        throw new Error("Packed notification reporting lost an original failure", {
          cause: failure,
        });
      }
    }
  } finally {
    subscription[disposeSymbol]();
    publisher[disposeSymbol]();
    await host[asyncDisposeSymbol]();
  }
}
