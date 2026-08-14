const contractType: unique symbol = Symbol("dougong.contract.type");

export type ContractKind = "service" | "extension" | "event";

interface Contract<T, K extends ContractKind> {
  readonly id: string;
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
  if (
    !token ||
    token.kind !== "service" ||
    typeof token.id !== "string" ||
    !token.id.trim() ||
    token.id !== token.id.trim()
  ) {
    throw new TypeError("optional() expects a service contract");
  }
  return Object.freeze({ kind: "optional", service: token });
}
