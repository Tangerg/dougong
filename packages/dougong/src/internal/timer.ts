// Native timers use a signed 32-bit millisecond delay; overflow can expire almost immediately.
const maximumTimerDelay = 2 ** 31 - 1;

export function captureTimerDelay(value: unknown, label: string): number | undefined {
  if (value === undefined) return;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > maximumTimerDelay
  )
    throw new TypeError(
      `${label} must be a positive finite number no greater than ${maximumTimerDelay}`,
    );
  return value;
}
