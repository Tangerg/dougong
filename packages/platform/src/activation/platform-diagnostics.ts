import type { HostSnapshot, Logger, SnapshotView } from "dougong";
import { ReadonlyMapSnapshot, resolveValue } from "dougong/advanced";
import type { RegistrationRecord, RegistrationSnapshot } from "../catalog/registration.js";
import type { HostObservation } from "./host-observation.js";

export type PlatformStatus = "active" | "disposing" | "disposed";

export interface PlatformSnapshot {
  readonly id: string;
  readonly apiVersion: string;
  readonly status: PlatformStatus;
  readonly registrations: ReadonlyMap<string, RegistrationSnapshot>;
}

export interface PlatformFacts<Reference> {
  readonly id: string;
  readonly apiVersion: string;
  readonly status: PlatformStatus;
  readonly registrations: ReadonlyMap<string, RegistrationRecord<Reference>>;
  readonly hostSnapshot: HostSnapshot | undefined;
}

// Unchanged registrations keep their snapshot identity so subscribers can compare by reference.
export function projectPlatformSnapshot<Reference>(
  facts: PlatformFacts<Reference>,
  previous?: PlatformSnapshot,
): PlatformSnapshot {
  const installations = new Map(
    facts.hostSnapshot?.installations.map((installation) => [installation.id, installation]),
  );
  let changed =
    previous?.status !== facts.status || previous.registrations.size !== facts.registrations.size;
  const entries = [...facts.registrations].map(([name, registration]) => {
    const before = previous?.registrations.get(name);
    const installation = registration.installation ? installations.get(registration.id) : undefined;
    const next = registration.snapshot(installation, before);
    if (before !== next) changed = true;
    return [name, next] as const;
  });
  if (!changed && previous) return previous;
  return Object.freeze({
    id: facts.id,
    apiVersion: facts.apiVersion,
    status: facts.status,
    registrations: new ReadonlyMapSnapshot(entries),
  });
}

// A retained view must not capture its owner's constructor scope after the binding is detached.
export function diagnosticView<T>(
  view: SnapshotView<T>,
  binding: Pick<HostObservation, "synchronize">,
): SnapshotView<T> {
  const get = () => {
    binding.synchronize();
    return view.get();
  };
  return Object.freeze({
    get,
    subscribe(listener: () => void) {
      if (typeof listener !== "function") return view.subscribe(listener);
      let previous = get();
      return view.subscribe(() => {
        const current = get();
        if (current === previous) return;
        previous = current;
        return listener();
      });
    },
  });
}

export function terminalReporter(logger: Logger<unknown>) {
  return (error: unknown) => {
    try {
      // The terminal sink has no lower reporter, but its rejection must still be observed.
      void resolveValue(logger.error(error)).catch(() => undefined);
    } catch {
      // Observer failures must not change the outcome of a committed operation.
    }
  };
}
