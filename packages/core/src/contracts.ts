declare const contractBrand: unique symbol;
declare const contractValueSlot: unique symbol;
declare const optionalBrand: unique symbol;

interface ContractValueSlot<T> {
  readonly value: T;
  readonly accept: (value: T) => void;
}

export type ContractKind = "service" | "extensionPoint" | "event";

export interface ContractIdentity {
  readonly id: string;
  readonly kind: ContractKind;
}

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

interface OptionalServiceIdentity {
  readonly [optionalBrand]: true;
  readonly kind: "optional";
  readonly service: ServiceIdentity;
}

export interface OptionalService<T> extends OptionalServiceIdentity {
  readonly service: Service<T>;
  readonly [contractValueSlot]: ContractValueSlot<T>;
}

export type Requirement = ServiceIdentity | ExtensionPointIdentity | OptionalServiceIdentity;

export type ContractValue<T> = T extends Contract<infer Value, ContractKind> ? Value : never;

function validateId(label: string, id: string) {
  if (typeof id !== "string" || !id.trim()) {
    throw new TypeError(`${label} id must be a non-empty string`);
  }
  if (id !== id.trim()) {
    throw new TypeError(`${label} id cannot start or end with whitespace`);
  }
}

function contract<T, K extends ContractKind>(kind: K, id: string): Contract<T, K> {
  validateId("Contract", id);
  return Object.freeze({ id, kind }) as Contract<T, K>;
}

export function isContract(value: unknown, expected?: ContractKind): value is ContractIdentity {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ContractIdentity>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    candidate.id === candidate.id.trim() &&
    (candidate.kind === "service" ||
      candidate.kind === "extensionPoint" ||
      candidate.kind === "event") &&
    (expected === undefined || candidate.kind === expected)
  );
}

export function assertContract(
  value: unknown,
  expected?: ContractKind,
): asserts value is ContractIdentity {
  if (isContract(value, expected)) return;
  throw new TypeError(expected ? `Expected ${contractDescription(expected)}` : "Invalid contract");
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
  if (!isContract(token, "service")) {
    throw new TypeError("optional() expects a Service");
  }
  return Object.freeze({ kind: "optional", service: token }) as OptionalService<T>;
}

export function isOptionalService<T>(
  value: Service<T> | OptionalService<T>,
): value is OptionalService<T> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<OptionalServiceIdentity>;
  return candidate.kind === "optional" && isContract(candidate.service, "service");
}
