import type { StandardSchemaV1 } from "@standard-schema/spec";
import { abortReason, isAborted } from "../internal/abort.js";
import { captureDataArray } from "../internal/data-array.js";
import { assertTrimmedText } from "../internal/text.js";

export const changeConflictCode = "CHANGE_CONFLICT";
export const changeForeignCode = "CHANGE_FOREIGN";
const configurationInvalidCode = "CONFIGURATION_INVALID";
export const contractConflictCode = "CONTRACT_CONFLICT";
export const contributionUnavailableCode = "CONTRIBUTION_UNAVAILABLE";
export const eventBeforeCommitCode = "EVENT_BEFORE_COMMIT";
export const groupConflictCode = "GROUP_CONFLICT";
export const groupCycleCode = "GROUP_CYCLE";
export const groupForeignCode = "GROUP_FOREIGN";
export const groupMissingCode = "GROUP_MISSING";
export const groupRemovedCode = "GROUP_REMOVED";
export const hostBusyCode = "HOST_BUSY";
export const hostQuarantinedCode = "HOST_QUARANTINED";
export const installationConflictCode = "INSTALLATION_CONFLICT";
export const installationForeignCode = "INSTALLATION_FOREIGN";
export const installationRemovedCode = "INSTALLATION_REMOVED";
export const lifetimeBusyCode = "LIFETIME_BUSY";
export const lifetimeDisposedCode = "LIFETIME_DISPOSED";
export const planConsumedCode = "PLAN_CONSUMED";
export const planForeignCode = "PLAN_FOREIGN";
export const planStaleCode = "PLAN_STALE";
export const providesInvalidCode = "PROVIDES_INVALID";
export const serviceConflictCode = "SERVICE_CONFLICT";
export const serviceCycleCode = "SERVICE_CYCLE";
export const serviceMissingCode = "SERVICE_MISSING";
export const serviceUnavailableCode = "SERVICE_UNAVAILABLE";
export const shutdownTimeoutCode = "SHUTDOWN_TIMEOUT";
export const transitionFailedCode = "TRANSITION_FAILED";

// One schema serves both strict construction and bounded diagnostic projection.
export const detailKinds = Object.freeze({
  outcome: "outcome",
  phase: "text",
  installation: "text",
  contract: "text",
  dependencyPath: "path",
  affectedInstallations: "path",
  stateRevision: "revision",
  expectedRevision: "revision",
} as const);
export const outcomes = Object.freeze(["rejected", "restored", "quarantined"] as const);

export type DetailField = keyof typeof detailKinds;

interface DetailValues {
  readonly outcome: (typeof outcomes)[number];
  readonly text: string;
  readonly path: ReadonlyArray<string>;
  readonly revision: number;
}

export type ErrorDetails = {
  readonly [Field in DetailField]?: DetailValues[(typeof detailKinds)[Field]];
};

export function isDetailRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// Construction rejects invalid declarations instead of silently dropping a caller's detail.
function captureDetails(source: object): ErrorDetails {
  const fields: Record<string, string | number | ReadonlyArray<string>> = {};
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key !== "string" || !Object.hasOwn(detailKinds, key))
      throw new TypeError(`Unknown error detail '${String(key)}'`);
    const raw: unknown = Reflect.get(source, key);
    if (raw === undefined) continue;
    const field = captureDetail(detailKinds[key as DetailField], raw, key);
    if (field === undefined) throw new TypeError(`Invalid error detail '${key}'`);
    fields[key] = field;
  }
  return Object.freeze(fields);
}

function captureDetail(kind: (typeof detailKinds)[DetailField], raw: unknown, key: string) {
  switch (kind) {
    case "outcome":
      return outcomes.find((outcome) => outcome === raw);
    case "text":
      return typeof raw === "string" ? raw : undefined;
    case "revision":
      return isDetailRevision(raw) ? raw : undefined;
    case "path": {
      const items = captureDataArray(raw, key);
      return items.every((item): item is string => typeof item === "string") ? items : undefined;
    }
  }
}

export class DougongError<Code extends string = string> extends Error {
  override name = "DougongError";
  readonly code: Code;
  readonly details: ErrorDetails;

  constructor(
    code: Code,
    message: string,
    options?: ErrorOptions & { readonly details?: ErrorDetails },
  ) {
    assertTrimmedText(code, "DougongError code");
    if (typeof message !== "string") throw new TypeError("DougongError message must be a string");
    super(message, options);
    this.code = code;
    const details = options?.details;
    if (
      details !== undefined &&
      (!details || typeof details !== "object" || Array.isArray(details))
    )
      throw new TypeError("Error details must be an object");
    this.details = captureDetails(details ?? {});
  }
}

export function quarantinedHost(revision: number) {
  return new DougongError(hostQuarantinedCode, "Host execution is permanently quarantined", {
    details: { outcome: "quarantined", stateRevision: revision },
  });
}

// Unreadable prototypes do not prove that a rejection value is an Error.
export function isError(value: unknown): value is Error {
  try {
    if (value instanceof Error) return true;
    if (value === null || typeof value !== "object") return false;
    if ("isError" in Error && typeof Error.isError === "function") return Error.isError(value);
    // Older engines expose the native cross-realm brand only when no custom string tag shadows it.
    return (
      !(Symbol.toStringTag in value) && Object.prototype.toString.call(value) === "[object Error]"
    );
  } catch {
    return false;
  }
}

// Selecting a domain field must not invoke a second application getter while recording a failure.
export function ownDataField(value: unknown, key: string) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor : undefined;
  } catch {
    return undefined;
  }
}

// A throwing accessor on a rejection value must not replace the failure being reported.
export function readErrorProperty(value: unknown, key: PropertyKey): unknown {
  try {
    return value && typeof value === "object"
      ? (value as Record<PropertyKey, unknown>)[key]
      : undefined;
  } catch {
    return undefined;
  }
}

export function isPropertyKey(value: unknown): value is PropertyKey {
  return typeof value === "string" || typeof value === "number" || typeof value === "symbol";
}

// Names alone cannot establish causality after cancellation overtakes an independent rejection.
export function isCancellationReason(signal: AbortSignal, error: unknown) {
  try {
    if (!isAborted(signal)) return false;
  } catch (cause) {
    throw new TypeError("Cancellation classifier expects an AbortSignal", { cause });
  }
  const reason = abortReason(signal);
  if (Object.is(error, reason)) return true;
  return (
    isError(error) &&
    readErrorProperty(error, "name") === "AbortError" &&
    Object.is(ownDataField(error, "cause")?.value, reason)
  );
}

export class ConfigurationValidationError extends DougongError {
  override name = "ConfigurationValidationError";
  readonly issues: ReadonlyArray<StandardSchemaV1.Issue>;

  constructor(
    issues: ReadonlyArray<StandardSchemaV1.Issue>,
    options?: ErrorOptions & { readonly details?: ErrorDetails },
  ) {
    const snapshot = snapshotValidationIssues(issues);
    super(
      configurationInvalidCode,
      `Invalid Plugin configuration:\n${snapshot.map((issue) => `  - ${issue.message}`).join("\n")}`,
      options,
    );
    this.issues = snapshot;
  }
}

// Copy validator issues so retained errors cannot retain third-party object graphs.
function snapshotValidationIssues(issues: unknown): ReadonlyArray<StandardSchemaV1.Issue> {
  return Object.freeze(
    captureValidationArray(issues, "Configuration validation issues").map((issue, index) => {
      if (!issue || (typeof issue !== "object" && typeof issue !== "function")) {
        throw new TypeError(`Configuration validation issue at index ${index} must be an object`);
      }
      const candidate = issue as { readonly message?: unknown; readonly path?: unknown };
      const message = candidate.message;
      if (typeof message !== "string") {
        throw new TypeError(
          `Configuration validation issue at index ${index} message must be a string`,
        );
      }
      const path = candidate.path;
      return Object.freeze({
        message,
        ...(path === undefined ? {} : { path: snapshotValidationPath(path, index) }),
      });
    }),
  );
}

function snapshotValidationPath(path: unknown, issueIndex: number) {
  return Object.freeze(
    captureValidationArray(path, `Configuration validation issue at index ${issueIndex} path`).map(
      (part, pathIndex) => {
        if (isPropertyKey(part)) return part;
        if (!part || (typeof part !== "object" && typeof part !== "function")) {
          throw new TypeError(
            `Configuration validation issue at index ${issueIndex} path segment ${pathIndex} must be a property key`,
          );
        }
        const key = (part as { readonly key?: unknown }).key;
        if (!isPropertyKey(key)) {
          throw new TypeError(
            `Configuration validation issue at index ${issueIndex} path segment ${pathIndex} must contain a property key`,
          );
        }
        return Object.freeze({ key });
      },
    ),
  );
}

// Standard Schema arrays may carry metadata or accessors; only their indexed protocol values are retained.
function captureValidationArray(input: unknown, label: string): ReadonlyArray<unknown> {
  if (!Array.isArray(input)) throw new TypeError(`${label} must be an array`);
  const length: unknown = input.length;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0)
    throw new TypeError(`${label} must have a valid array length`);
  const values: unknown[] = [];
  for (let index = 0; index < length; index++) {
    if (!(index in input)) throw new TypeError(`${label} must be a dense array`);
    values.push(input[index]);
  }
  return Object.freeze(values);
}
