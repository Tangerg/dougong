export interface Completion<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

/** Creates a promise whose identity can be published before fallible work begins. */
export function createCompletion<T>(): Completion<T> {
  let controls: Omit<Completion<T>, "promise"> | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    controls = { resolve, reject };
  });
  if (!controls) throw new Error("Promise executor did not initialize completion controls");
  return { promise, ...controls };
}
