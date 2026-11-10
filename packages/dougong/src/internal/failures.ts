// A single failure keeps its identity; several stay together instead of reporting only the first.
export function combineFailures(errors: ReadonlyArray<unknown>, message: string): unknown {
  return errors.length === 1 ? errors[0] : new AggregateError(errors, message);
}
