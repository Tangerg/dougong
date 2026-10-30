import { DougongError } from "../contracts/errors.js";
import type { InstallationGraph } from "./installation-graph.js";
import type { InstallationDeclaration, InstallationRecord } from "./installation.js";
import type { GroupNode } from "./group.js";
import type { ConfigValue } from "./configuration.js";
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
  readonly blockers: ReadonlyArray<never>;
  readonly execution: { readonly atomicPublication: true; readonly externalEffectsRollback: false };
}
declare const planBrand: unique symbol;
export interface Plan {
  readonly [planBrand]: true;
  readonly report: PlanReport;
}
export interface PreparedTransition {
  readonly intent: TransitionIntent;
  readonly baseStateRevision: number;
  readonly declarations: ReadonlyMap<InstallationRecord, InstallationDeclaration>;
  readonly groups: ReadonlyMap<string, GroupNode>;
  readonly graph: InstallationGraph;
  readonly affected: ReadonlySet<InstallationRecord>;
  readonly configs: ReadonlyMap<InstallationRecord, { readonly value: ConfigValue | undefined }>;
  readonly report: PlanReport;
}

export class PlanAuthority {
  readonly #plans = new WeakMap<Plan, PreparedTransition | null>();
  issue(prepared: PreparedTransition): Plan {
    const plan = Object.freeze({ report: prepared.report }) as Plan;
    this.#plans.set(plan, prepared);
    return plan;
  }
  read(plan: Plan): PreparedTransition {
    const prepared = this.#plans.get(plan);
    if (prepared === undefined)
      throw new DougongError("PLAN_FOREIGN", "Plan was not issued by this Host");
    if (prepared === null)
      throw new DougongError("PLAN_CONSUMED", "Plan has already been executed");
    return prepared;
  }
  consume(plan: Plan) {
    this.#plans.set(plan, null);
  }
}

export function describeBindings(graph: InstallationGraph): ReadonlyArray<BindingReport> {
  return Object.freeze(
    graph.order.flatMap((installation) =>
      Object.values(graph.declarationFor(installation).plugin.requires).flatMap((requirement) => {
        if (requirement.kind === "extensionPoint") return [];
        const token = requirement.kind === "optional" ? requirement.service : requirement;
        return [
          Object.freeze({
            installation: installation.id,
            contract: token.id,
            optional: requirement.kind === "optional",
            provider: graph.providerFor(installation, token.id)?.id,
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
  const before = describeBindings(previous);
  const after = describeBindings(candidate);
  const affectedIds = new Set([...affected].map((installation) => installation.id));
  for (const installation of affected) {
    const kind = direct.get(installation);
    if (kind) {
      reasons.push(Object.freeze({ installation: installation.id, kind }));
      continue;
    }
    const contracts = new Set(
      [...before, ...after]
        .filter((binding) => binding.installation === installation.id)
        .map((binding) => binding.contract),
    );
    for (const contract of contracts) {
      const previousProvider = before.find(
        (binding) => binding.installation === installation.id && binding.contract === contract,
      )?.provider;
      const provider = after.find(
        (binding) => binding.installation === installation.id && binding.contract === contract,
      )?.provider;
      if (
        !(previousProvider && affectedIds.has(previousProvider)) &&
        !(provider && affectedIds.has(provider))
      )
        continue;
      reasons.push(
        Object.freeze({
          installation: installation.id,
          kind: "provider_changed",
          contract,
          ...(previousProvider === undefined ? {} : { previousProvider }),
          ...(provider === undefined ? {} : { provider }),
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
