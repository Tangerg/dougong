// Contract tokens: the identity layer that every other Core atom is keyed by.
//
// A token carries no value and no behavior — it is a frozen `{ id, kind }` pair.
// Its type parameter names the value that will flow through it and appears in no
// runtime field, so it lives in a declared-only slot where the compiler can
// still check it.

declare const contractBrand: unique symbol;
declare const contractValueSlot: unique symbol;
declare const optionalBrand: unique symbol;

/**
 * Holds `T` in a covariant and a contravariant position at once, which makes
 * every Contract invariant in `T`. Without the contravariant half, `Service<Cat>`
 * would be assignable to `Service<Animal>` and `host.get()` could hand back a
 * value narrower than the token the caller passed in.
 */
interface ContractValueSlot<T> {
  readonly value: T;
  readonly accept: (value: T) => void;
}

export type ContractKind = "service" | "extensionPoint" | "event";

/** The erased half of a token: all a registry needs to key it, with no value type. */
export interface ContractIdentity {
  readonly id: string;
  readonly kind: ContractKind;
}

/**
 * Nominal marker. A structurally identical `{ id, kind }` literal is not a
 * Contract, so a token has to come from `service()`, `event()` or
 * `extensionPoint()` rather than from an object written at the call site.
 */
interface ContractBrand {
  readonly [contractBrand]: true;
}

interface Contract<T, K extends ContractKind> extends ContractIdentity, ContractBrand {
  readonly kind: K;
  readonly [contractValueSlot]: ContractValueSlot<T>;
}

interface ServiceIdentity extends ContractIdentity, ContractBrand {
  readonly kind: "service";
}

interface ExtensionPointIdentity extends ContractIdentity, ContractBrand {
  readonly kind: "extensionPoint";
}

export interface Service<T> extends Contract<T, "service"> {}
export interface ExtensionPoint<T> extends Contract<T, "extensionPoint"> {}
export interface Event<T> extends Contract<T, "event"> {}

/**
 * `optional()` wraps rather than flags, so the required and optional forms of
 * one Service stay distinct values. A Plugin cannot weaken a hard dependency by
 * mutating a shared token.
 */
interface OptionalServiceIdentity {
  readonly [optionalBrand]: true;
  readonly kind: "optional";
  readonly service: ServiceIdentity;
}

export interface OptionalService<T> extends OptionalServiceIdentity {
  readonly service: Service<T>;
  readonly [contractValueSlot]: ContractValueSlot<T>;
}

/**
 * Everything a Plugin may name in `requires`. Events are absent on purpose: an
 * Event is a transient fact reached through the Lifetime, never something whose
 * presence the dependency graph can order.
 */
export type Requirement = ServiceIdentity | ExtensionPointIdentity | OptionalServiceIdentity;

export type ContractValue<T> = T extends Contract<infer Value, ContractKind> ? Value : never;

function validateId(label: string, id: unknown) {
  if (isValidContractId(id)) return;
  throw new TypeError(
    typeof id === "string" && id.trim()
      ? `${label} id cannot start or end with whitespace`
      : `${label} id must be a non-empty string`,
  );
}

function isValidContractId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id === id.trim();
}

function contract<T, K extends ContractKind>(kind: K, id: string): Contract<T, K> {
  validateId("Contract", id);
  return Object.freeze({ id, kind }) as Contract<T, K>;
}

function readDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function readContractIdentity(value: object, kind: unknown): ContractIdentity | undefined {
  const id = readDataProperty(value, "id");
  if (!isValidContractId(id)) return undefined;
  if (kind !== "service" && kind !== "extensionPoint" && kind !== "event") return undefined;
  return { id, kind };
}

/** Takes ownership of inert identity data before any registry or lookup uses it. */
export function normalizeContract<T extends ContractIdentity>(
  value: T,
  expected?: ContractKind,
  message?: string,
): T;
export function normalizeContract(
  value: unknown,
  expected?: ContractKind,
  message?: string,
): ContractIdentity;
export function normalizeContract(
  value: unknown,
  expected?: ContractKind,
  message?: string,
): ContractIdentity {
  const identity =
    value && typeof value === "object"
      ? readContractIdentity(value, readDataProperty(value, "kind"))
      : undefined;
  if (!identity || (expected !== undefined && identity.kind !== expected)) {
    throw new TypeError(
      message ?? (expected ? `Expected ${contractDescription(expected)}` : "Invalid contract"),
    );
  }
  return Object.freeze(identity);
}

function contractDescription(kind: ContractKind) {
  if (kind === "extensionPoint") return "an ExtensionPoint";
  if (kind === "event") return "an Event";
  return "a Service";
}

export function service<T>(id: string): Service<T> {
  return contract<T, "service">("service", id);
}

export function event<T>(id: string): Event<T> {
  return contract<T, "event">("event", id);
}

export function extensionPoint<T>(id: string): ExtensionPoint<T> {
  return contract<T, "extensionPoint">("extensionPoint", id);
}

export function optional<T>(token: Service<T>): OptionalService<T> {
  return Object.freeze({
    kind: "optional",
    service: normalizeContract(token, "service", "optional() expects a Service"),
  }) as OptionalService<T>;
}

/** Captures both optionality and identity; consumers never reread the input. */
export function normalizeRequirement(
  value: unknown,
  message = "Expected a Service or ExtensionPoint",
  optionalMessage = "Expected a Service",
): Requirement {
  if (!value || typeof value !== "object") throw new TypeError(message);
  const kind = readDataProperty(value, "kind");
  if (kind === "optional") {
    return Object.freeze({
      kind,
      service: normalizeContract(readDataProperty(value, "service"), "service", optionalMessage),
    }) as Requirement;
  }
  const identity = readContractIdentity(value, kind);
  if (!identity || identity.kind === "event") throw new TypeError(message);
  return Object.freeze(identity) as Requirement;
}
