const contractType: unique symbol = Symbol("dougong.contract.type");

export type ContractKind = "service" | "extension" | "event";

export interface ContractIdentity {
  readonly id: string;
  readonly kind: ContractKind;
}

interface Contract<T, K extends ContractKind> extends ContractIdentity {
  readonly kind: K;
  readonly [contractType]?: T;
}

export interface Service<T> extends Contract<T, "service"> {}
export interface Extension<T> extends Contract<T, "extension"> {}
export interface Event<T> extends Contract<T, "event"> {}

export interface OptionalService<T> {
  readonly kind: "optional";
  readonly service: Service<T>;
}

export type Requirement<T = unknown> = Service<T> | Extension<T> | OptionalService<T>;

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
      candidate.kind === "extension" ||
      candidate.kind === "event") &&
    (expected === undefined || candidate.kind === expected)
  );
}

export function assertContract(
  value: unknown,
  expected?: ContractKind,
): asserts value is ContractIdentity {
  if (isContract(value, expected)) return;
  throw new TypeError(expected ? `Expected a ${expected} contract` : "Invalid contract");
}

export function service<T>(id: string): Service<T> {
  return contract<T, "service">("service", id);
}

export function event<T>(id: string): Event<T> {
  return contract<T, "event">("event", id);
}

export function extension<T>(id: string): Extension<T> {
  return contract<T, "extension">("extension", id);
}

export function optional<T>(token: Service<T>): OptionalService<T> {
  if (!isContract(token, "service")) {
    throw new TypeError("optional() expects a service contract");
  }
  return Object.freeze({ kind: "optional", service: token });
}
