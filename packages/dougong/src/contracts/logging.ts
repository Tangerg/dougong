import type { SynchronousResult } from "../internal/async-result.js";

export interface Logger<Result = SynchronousResult<void>> {
  readonly debug: (message: unknown, ...details: unknown[]) => Result;
  readonly info: (message: unknown, ...details: unknown[]) => Result;
  readonly warn: (message: unknown, ...details: unknown[]) => Result;
  readonly error: (message: unknown, ...details: unknown[]) => Result;
}

const invalidLoggerMessage = "Logger must implement debug/info/warn/error";

export function captureLogger<Input extends Logger<unknown>>(
  value: Input,
): {
  readonly [Level in keyof Logger]: (
    ...arguments_: Parameters<Logger<unknown>[Level]>
  ) => ReturnType<Input[Level]>;
};
export function captureLogger(value: unknown): Logger<unknown>;
export function captureLogger(value: unknown): Logger<unknown> {
  if (!value || (typeof value !== "object" && typeof value !== "function"))
    throw new TypeError(invalidLoggerMessage);
  const capture = (level: keyof Logger): Logger<unknown>[typeof level] => {
    const method = (value as Partial<Logger<unknown>>)[level];
    if (typeof method !== "function") throw new TypeError(invalidLoggerMessage);
    return (...messageArguments) => Reflect.apply(method, value, messageArguments);
  };
  return Object.freeze({
    debug: capture("debug"),
    info: capture("info"),
    warn: capture("warn"),
    error: capture("error"),
  });
}

export function isLogger(value: unknown): value is Logger<unknown> {
  try {
    captureLogger(value);
    return true;
  } catch {
    return false;
  }
}
