import type { StandardSchemaV1 } from "@standard-schema/spec";
import { abortReason, isAborted } from "../internal/abort.js";
import { captureDataArray } from "../internal/data-array.js";

export const lifetimeBusyCode = "BUSY";
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

const maximumDiagnosticFields = 8;
const maximumDiagnosticFieldNameLength = 256;
const maximumDiagnosticFieldTextLength = 256;
const maximumDiagnosticFieldItems = 8;
const maximumErrorDepth = 4;
const maximumRecordedErrors = 32;
const maximumErrorNameLength = 256;
const maximumErrorCodeLength = 256;
const maximumErrorMessageLength = 4096;
const maximumErrorStackLength = 16384;
const maximumAggregateErrors = 8;
const maximumValidationIssues = 8;
const maximumValidationPathSegments = 16;
const maximumValidationPathSegmentLength = 256;
const maximumErrorDetailTextLength = 256;
const maximumErrorDetailPathItems = 32;

const detailKinds = {
  outcome: "outcome",
  phase: "text",
  installation: "text",
  contract: "text",
  dependencyPath: "path",
  affectedInstallations: "path",
  stateRevision: "revision",
  expectedRevision: "revision",
} as const;
const outcomes = ["rejected", "restored", "quarantined"] as const;

interface DetailValues {
  readonly outcome: (typeof outcomes)[number];
  readonly text: string;
  readonly path: ReadonlyArray<string>;
  readonly revision: number;
}

export type ErrorDetails = {
  readonly [Field in keyof typeof detailKinds]?: DetailValues[(typeof detailKinds)[Field]];
};

interface DetailBounds {
  readonly clip: (text: string, limit: number) => string;
  readonly strings: (
    value: unknown,
    limit: number,
    itemLength: number,
  ) => ReadonlyArray<string> | undefined;
}

// The constructor rejects invalid declarations; diagnostics can only project readable, bounded fields.
function captureDetails(source: object, bounds?: DetailBounds): ErrorDetails {
  const fields: Record<string, string | number | ReadonlyArray<string>> = {};
  for (const key of bounds ? Object.keys(detailKinds) : Reflect.ownKeys(source)) {
    if (typeof key !== "string" || !Object.hasOwn(detailKinds, key))
      throw new TypeError(`Unknown error detail '${String(key)}'`);
    const raw: unknown = bounds ? readErrorProperty(source, key) : Reflect.get(source, key);
    if (raw === undefined) continue;
    let field: DetailValues[keyof DetailValues] | undefined;
    switch (detailKinds[key as keyof ErrorDetails]) {
      case "outcome":
        field = outcomes.find((outcome) => outcome === raw);
        break;
      case "text":
        if (typeof raw === "string")
          field = bounds ? bounds.clip(raw, maximumErrorDetailTextLength) : raw;
        break;
      case "revision":
        if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) field = raw;
        break;
      case "path":
        if (bounds)
          field = bounds.strings(raw, maximumErrorDetailPathItems, maximumErrorDetailTextLength);
        else {
          const items = captureDataArray(raw, key);
          if (items.every((item): item is string => typeof item === "string")) field = items;
        }
        break;
    }
    if (field !== undefined) fields[key] = field;
    else if (!bounds) throw new TypeError(`Invalid error detail '${key}'`);
  }
  return Object.freeze(fields);
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
    if (typeof code !== "string" || code.trim() !== code || code.length === 0) {
      throw new TypeError("DougongError code must be a non-empty trimmed string");
    }
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

export interface ErrorSnapshot {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly stack?: string;
  readonly cause?: ErrorSnapshot;
  readonly error?: ErrorSnapshot;
  readonly suppressed?: ErrorSnapshot;
  readonly errors?: ReadonlyArray<ErrorSnapshot>;
  readonly details?: ErrorDetails;
  readonly fields?: Readonly<Record<string, string | ReadonlyArray<string>>>;
  readonly issues?: ReadonlyArray<{
    readonly message: string;
    readonly path?: ReadonlyArray<string | number>;
  }>;
  readonly truncated?: true;
}

// Terminal diagnostics must not retain application resources through Error causes or custom fields.
export class RecordedFailure extends Error {
  override readonly name = "RecordedFailure";
  readonly code: string | undefined;
  readonly #snapshot: ErrorSnapshot;

  get snapshot() {
    return this.#snapshot;
  }

  static #recorded(value: unknown) {
    return value !== null && typeof value === "object" && #snapshot in value
      ? value.#snapshot
      : undefined;
  }

  constructor(error: unknown, fields: ReadonlyArray<string> = []) {
    const names = captureDataArray(fields, "Diagnostic field names");
    if (
      names.length > maximumDiagnosticFields ||
      names.some(
        (name) =>
          typeof name !== "string" || !name || name.length > maximumDiagnosticFieldNameLength,
      )
    ) {
      throw new TypeError(
        `Select at most ${maximumDiagnosticFields} diagnostic field names of 1–${maximumDiagnosticFieldNameLength} characters each`,
      );
    }
    const snapshot =
      RecordedFailure.#recorded(error) ??
      captureError(error, RecordedFailure.#recorded, new Set(names));
    super(snapshot.message);
    this.code = snapshot.code;
    this.#snapshot = snapshot;
    // Replace even a missing stack so V8 constructor frames cannot retain the recorded application.
    this.stack = snapshot.stack ?? `${this.name}: ${snapshot.message}`;
    Object.freeze(this);
  }
}

function captureError(
  error: unknown,
  recorded: (value: unknown) => ErrorSnapshot | undefined,
  fieldNames: ReadonlySet<string>,
): ErrorSnapshot {
  const seen = new Set<unknown>();
  let remaining = maximumRecordedErrors;
  const visit = (raw: unknown, depth: number, fromSnapshot = false): ErrorSnapshot => {
    // A nested record still shares this report's depth and size budget.
    const sealed = fromSnapshot ? (raw as ErrorSnapshot) : recorded(raw);
    const value = sealed ?? raw;
    if (depth > maximumErrorDepth || remaining-- <= 0 || seen.has(value)) {
      return Object.freeze({
        name: "TruncatedError",
        message: "Error chain truncated",
        truncated: true,
      });
    }
    if (!sealed && !isError(value)) {
      const message =
        value === null ||
        ["string", "number", "boolean", "undefined", "bigint", "symbol"].includes(typeof value)
          ? String(value)
          : "Non-Error object omitted";
      return Object.freeze({
        name: "NonError",
        message: message.slice(0, maximumErrorMessageLength),
        ...(message.length > maximumErrorMessageLength ? { truncated: true as const } : {}),
      });
    }
    seen.add(value);
    let truncated = sealed?.truncated ?? false;
    const clip = (raw: string, limit: number) => {
      if (raw.length > limit) truncated = true;
      return raw.slice(0, limit);
    };
    const string = (key: string, limit: number) => {
      const raw = readErrorProperty(value, key);
      return typeof raw === "string" ? clip(raw, limit) : undefined;
    };
    const list = (raw: unknown, limit: number) => {
      if (!isRecordableArray(raw)) return undefined;
      const length = readErrorProperty(raw, "length");
      if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
        return undefined;
      }
      if (length > limit) truncated = true;
      return Array.from({ length: Math.min(length, limit) }, (_, index) =>
        readErrorProperty(raw, index),
      );
    };
    const name = string("name", maximumErrorNameLength) ?? "Error";
    const message = string("message", maximumErrorMessageLength) ?? "";
    const stack = string("stack", maximumErrorStackLength);
    const code = string("code", maximumErrorCodeLength);
    const cause = readErrorProperty(value, "cause");
    const errors = list(readErrorProperty(value, "errors"), maximumAggregateErrors);
    const strings = (raw: unknown, limit: number, itemLength: number) => {
      const items = list(raw, limit);
      return (
        items &&
        Object.freeze(
          items
            .filter((item): item is string => typeof item === "string")
            .map((item) => clip(item, itemLength)),
        )
      );
    };
    let fields = sealed?.fields;
    if (!sealed && fieldNames.size) {
      const entries: Array<[string, string | ReadonlyArray<string>]> = [];
      for (const key of fieldNames) {
        const raw = ownDataField(value, key)?.value;
        const data =
          typeof raw === "string"
            ? clip(raw, maximumDiagnosticFieldTextLength)
            : strings(raw, maximumDiagnosticFieldItems, maximumDiagnosticFieldTextLength);
        if (data !== undefined) entries.push([key, data]);
      }
      if (entries.length) fields = Object.freeze(Object.fromEntries(entries));
    }
    const issues = list(readErrorProperty(value, "issues"), maximumValidationIssues)?.map(
      (issue) => {
        const message = readErrorProperty(issue, "message");
        const path = list(readErrorProperty(issue, "path"), maximumValidationPathSegments)?.map(
          (part) => {
            const key = part && typeof part === "object" ? readErrorProperty(part, "key") : part;
            return typeof key === "number"
              ? key
              : typeof key === "string" || typeof key === "symbol"
                ? clip(String(key), maximumValidationPathSegmentLength)
                : "[omitted]";
          },
        );
        return Object.freeze({
          message: typeof message === "string" ? clip(message, maximumErrorMessageLength) : "",
          ...(path ? { path: Object.freeze(path) } : {}),
        });
      },
    );
    const rawDetails = readErrorProperty(value, "details");
    const details =
      rawDetails !== null && typeof rawDetails === "object"
        ? captureDetails(rawDetails, { clip, strings })
        : undefined;
    const child = (value: unknown) => visit(value, depth + 1, !!sealed);
    // Native and downlevel suppression store both failures as own data, even when a subclass renames the Error.
    const primary = ownDataField(value, "error");
    const suppressed = primary && ownDataField(value, "suppressed");
    return Object.freeze({
      name,
      message,
      ...(code === undefined ? {} : { code }),
      ...(stack === undefined ? {} : { stack }),
      ...(cause === undefined ? {} : { cause: child(cause) }),
      ...(errors === undefined ? {} : { errors: Object.freeze(errors.map(child)) }),
      ...(primary && suppressed
        ? { error: child(primary.value), suppressed: child(suppressed.value) }
        : {}),
      ...(fields === undefined ? {} : { fields }),
      ...(issues === undefined ? {} : { issues: Object.freeze(issues) }),
      ...(details === undefined ? {} : { details }),
      ...(truncated ? { truncated: true as const } : {}),
    });
  };
  return visit(error, 0);
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

function isRecordableArray(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

// Selecting a domain field must not invoke a second application getter while recording a failure.
function ownDataField(value: unknown, key: string) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor : undefined;
  } catch {
    return undefined;
  }
}

function readErrorProperty(value: unknown, key: PropertyKey): unknown {
  try {
    return value && typeof value === "object"
      ? (value as Record<PropertyKey, unknown>)[key]
      : undefined;
  } catch {
    return undefined;
  }
}

// Only normalization grants provenance; copying constructors or prototypes cannot authorize reclassification.
const normalizedFailures = new WeakSet<Error>();

export function normalizeFailure(error: unknown, code: string, message: string): Error {
  let reason = error;
  if (isError(error)) {
    if (!normalizedFailures.has(error)) return error;
    if ((error as DougongError).code === code) return error;
    reason = error.cause;
  }
  const failure = new DougongError(code, message, { cause: reason });
  Object.freeze(failure);
  normalizedFailures.add(failure);
  return failure;
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

function isPropertyKey(value: unknown): value is PropertyKey {
  return typeof value === "string" || typeof value === "number" || typeof value === "symbol";
}
