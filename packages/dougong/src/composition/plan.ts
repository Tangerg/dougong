import {
  DougongError,
  quarantinedHost,
  planConsumedCode,
  planForeignCode,
  planStaleCode,
} from "../contracts/errors.js";
import type { InstallationGraph } from "./installation-graph.js";
import {
  PendingInstallations,
  type InstallationDeclaration,
  type InstallationRecord,
} from "./installation.js";
import type { GroupNode } from "./group.js";
import type { ConfigurationValue } from "./configuration.js";
import type { InstallationOrigin } from "./declarations.js";

export type TransitionIntent = "change" | "start" | "stop";
export interface BindingReport {
  readonly installation: string;
  readonly contract: string;
  readonly optional: boolean;
  readonly provider: string | undefined;
}
export interface ImpactReason {
  readonly installation: string;
  readonly kind: "installed" | "updated" | "removed" | "provider_changed" | "start" | "stop";
  readonly contract?: string;
  readonly provider?: string;
  readonly previousProvider?: string;
}
export interface DeclarationSnapshot {
  readonly pluginName: string;
  readonly origin: InstallationOrigin | undefined;
}
export type PlanOperation =
  | {
      readonly kind: "install" | "update" | "remove";
      readonly id: string;
      readonly before: DeclarationSnapshot | undefined;
      readonly after: DeclarationSnapshot | undefined;
    }
  | {
      readonly kind: "group" | "remove-group";
      readonly id: string;
      readonly parentId: string | undefined;
    };
export interface PlanReport {
  readonly baseStateRevision: number;
  readonly intent: TransitionIntent;
  readonly operations: ReadonlyArray<PlanOperation>;
  readonly bindings: {
    readonly before: ReadonlyArray<BindingReport>;
    readonly after: ReadonlyArray<BindingReport>;
  };
  readonly affectedInstallations: ReadonlyArray<string>;
  readonly reasons: ReadonlyArray<ImpactReason>;
  readonly stopOrder: ReadonlyArray<string>;
  readonly prepareOrder: ReadonlyArray<string>;
  readonly publishOrder: ReadonlyArray<string>;
  readonly execution: { readonly atomicPublication: true; readonly externalEffectsRollback: false };
}
declare const planBrand: unique symbol;
export interface Plan {
  readonly [planBrand]: true;
  readonly report: PlanReport;
}
export interface PreparedTransition {
  readonly groups: ReadonlyMap<string, GroupNode>;
  readonly graph: InstallationGraph;
  readonly affected: ReadonlySet<InstallationRecord>;
  readonly configurations: ReadonlyMap<
    InstallationRecord,
    { readonly value: ConfigurationValue | undefined }
  >;
  readonly report: PlanReport;
}

interface PlanBase {
  readonly revision: number;
  readonly graph: InstallationGraph;
}

function stalePlan(expectedRevision: number, stateRevision: number) {
  return new DougongError(planStaleCode, "Host state changed during or after planning", {
    details: { outcome: "rejected", expectedRevision, stateRevision },
  });
}

export class PlanAuthority {
  readonly #issued = new WeakMap<Plan, "issued" | "consumed">();
  #prepared = new WeakMap<Plan, PreparedTransition>();
  #pending = new PendingInstallations();
  #validation: AbortController | undefined;

  get validationSignal() {
    return (this.#validation ??= new AbortController()).signal;
  }

  issue(prepared: PreparedTransition, base: PlanBase): Plan {
    const { report } = prepared;
    if (report.baseStateRevision !== base.revision)
      throw stalePlan(report.baseStateRevision, base.revision);
    const plan = Object.freeze({ report }) as Plan;
    for (const record of prepared.graph.declarations.keys()) {
      if (!base.graph.declarations.has(record)) this.#pending.attach(record);
    }
    this.#issued.set(plan, "issued");
    this.#prepared.set(plan, prepared);
    return plan;
  }

  read(plan: Plan, revision: number): PreparedTransition {
    const issued = this.#issued.get(plan);
    if (issued === undefined)
      throw new DougongError(planForeignCode, "Plan was not issued by this Host");
    if (issued === "consumed")
      throw new DougongError(planConsumedCode, "Plan has already been executed");
    const prepared = this.#prepared.get(plan);
    if (!prepared) {
      this.consume(plan);
      throw stalePlan(plan.report.baseStateRevision, revision);
    }
    return prepared;
  }

  consume(plan: Plan) {
    this.#issued.set(plan, "consumed");
    this.#prepared.delete(plan);
  }

  invalidate(revision: number, quarantined: boolean) {
    // A shared revision rejection must remain authoritative after it reaches an individual caller.
    this.#validation?.abort(
      Object.freeze(quarantined ? quarantinedHost(revision) : stalePlan(revision - 1, revision)),
    );
    this.#validation = undefined;
    this.#pending.retire();
    this.#pending = new PendingInstallations();
    this.#prepared = new WeakMap();
  }
}

export function describeBindings(
  graph: InstallationGraph,
  installations: ReadonlyArray<InstallationRecord> = graph.order,
): ReadonlyArray<BindingReport> {
  return Object.freeze(
    installations.flatMap((installation) =>
      Object.values(graph.declarationFor(installation).plugin.requires).flatMap((requirement) => {
        if (requirement.kind === "extensionPoint") return [];
        const token = requirement.kind === "optional" ? requirement.service : requirement;
        return [
          Object.freeze({
            installation: installation.id,
            contract: token.id,
            optional: requirement.kind === "optional",
            provider: graph.providers.get(token.id)?.id,
          }),
        ];
      }),
    ),
  );
}

export function describeImpact(
  previous: InstallationGraph,
  candidate: InstallationGraph,
  affected: ReadonlySet<InstallationRecord>,
  direct: ReadonlyMap<InstallationRecord, ImpactReason["kind"]>,
): ReadonlyArray<ImpactReason> {
  const reasons: ImpactReason[] = [];
  for (const installation of affected) {
    const kind = direct.get(installation);
    if (kind) {
      reasons.push(Object.freeze({ installation: installation.id, kind }));
      continue;
    }
    // Indirectly affected declarations are unchanged; only their actual providers may have moved.
    for (const requirement of Object.values(
      candidate.declarationFor(installation).plugin.requires,
    )) {
      if (requirement.kind === "extensionPoint") continue;
      const contract = (requirement.kind === "optional" ? requirement.service : requirement).id;
      const previousProvider = previous.providers.get(contract);
      const provider = candidate.providers.get(contract);
      if (
        !(previousProvider && affected.has(previousProvider)) &&
        !(provider && affected.has(provider))
      )
        continue;
      reasons.push(
        Object.freeze({
          installation: installation.id,
          kind: "provider_changed",
          contract,
          ...(previousProvider === undefined ? {} : { previousProvider: previousProvider.id }),
          ...(provider === undefined ? {} : { provider: provider.id }),
        }),
      );
    }
  }
  return Object.freeze(reasons);
}

export function describeDeclaration(
  declaration: InstallationDeclaration | undefined,
): DeclarationSnapshot | undefined {
  return (
    declaration &&
    Object.freeze({ pluginName: declaration.plugin.name, origin: declaration.origin })
  );
}
