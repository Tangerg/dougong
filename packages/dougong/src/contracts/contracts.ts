import { assertTrimmedText, isTrimmedText } from "../internal/text.js";

declare const contractBrand: unique symbol;
declare const contractValueSlot: unique symbol;
declare const optionalBrand: unique symbol;

// Both variance positions prevent a token for a narrower value from satisfying a wider Contract.
interface ContractValueSlot<T> {
  readonly value: T;
  readonly accept: (value: T) => void;
}

const contractKinds = Object.freeze({
  service: Object.freeze({ name: "Service", article: "a" }),
  extensionPoint: Object.freeze({ name: "ExtensionPoint", article: "an" }),
  event: Object.freeze({ name: "Event", article: "an" }),
});

export type ContractKind = keyof typeof contractKinds;

export interface ContractIdentity {
  readonly id: string;
  readonly kind: ContractKind;
}

// The nominal marker prevents structural literals from bypassing token construction.
interface ContractBrand {
  readonly [contractBrand]: true;
}

interface Contract<T, Kind extends ContractKind> extends ContractIdentity, ContractBrand {
  readonly kind: Kind;
  readonly [contractValueSlot]: ContractValueSlot<T>;
}

export interface ServiceIdentity extends ContractIdentity, ContractBrand {
  readonly kind: "service";
}

export interface ExtensionPointIdentity extends ContractIdentity, ContractBrand {
  readonly kind: "extensionPoint";
}

export interface Service<T> extends Contract<T, "service"> {}
export interface ExtensionPoint<T> extends Contract<T, "extensionPoint"> {}
export interface Event<T> extends Contract<T, "event"> {}

// A wrapper prevents a caller from weakening a shared Service token by mutation.
interface OptionalServiceIdentity {
  readonly [optionalBrand]: true;
  readonly kind: "optional";
  readonly service: ServiceIdentity;
}

export interface OptionalService<T> extends OptionalServiceIdentity {
  readonly service: Service<T>;
  readonly [contractValueSlot]: ContractValueSlot<T>;
}

// Events cannot form dependency edges because they have no persistent presence to order.
export type Requirement = ServiceIdentity | ExtensionPointIdentity | OptionalServiceIdentity;

export type ContractValue<T> = T extends Contract<infer Value, ContractKind> ? Value : never;

export function contractKindName(kind: ContractKind): string {
  return contractKinds[kind].name;
}

function expectedContract(kind: ContractKind) {
  const { article, name } = contractKinds[kind];
  return `Expected ${article} ${name}`;
}

function isContractKind(value: unknown): value is ContractKind {
  return typeof value === "string" && Object.hasOwn(contractKinds, value);
}

export function requiredContract(
  requirement: Requirement,
): ServiceIdentity | ExtensionPointIdentity {
  return requirement.kind === "optional" ? requirement.service : requirement;
}

function contract<T, Kind extends ContractKind>(kind: Kind, id: string): Contract<T, Kind> {
  assertTrimmedText(id, "Contract id");
  return Object.freeze({ id, kind }) as Contract<T, Kind>;
}

function readDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !("value" in descriptor))
    throw new TypeError(`Contract field '${key}' must be a data property`);
  return descriptor?.value;
}

function readContractIdentity(value: object, kind: unknown): ContractIdentity | undefined {
  const id = readDataProperty(value, "id");
  if (!isTrimmedText(id) || !isContractKind(kind)) return undefined;
  return { id, kind };
}

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
    throw new TypeError(message ?? (expected ? expectedContract(expected) : "Invalid contract"));
  }
  return Object.freeze(identity);
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

export function normalizeRequirement(
  value: unknown,
  message = "Expected a Service or ExtensionPoint",
  optionalMessage = expectedContract("service"),
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
