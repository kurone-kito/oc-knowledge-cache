/**
 * Maps `items` with at most `limit` calls in flight and returns the results in
 * input order. The first rejection rejects the whole call.
 */
export const mapLimit = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  };
  // An unusable limit (NaN) means one at a time; Infinity means all at once.
  const requested = Number.isNaN(limit) ? 1 : Math.floor(limit);
  const workers = Array.from(
    { length: Math.max(1, Math.min(requested, items.length)) },
    worker,
  );
  await Promise.all(workers);
  return results;
};
