/** Indexed read that fails loudly instead of yielding undefined; callers stay in range. */
export function at(values: readonly number[], index: number): number {
  const value = values[index];
  if (value === undefined) {
    throw new RangeError(`index ${String(index)} out of range`);
  }
  return value;
}
