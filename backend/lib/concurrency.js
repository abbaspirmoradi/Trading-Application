/**
 * Runs `worker` over `items` with a bounded number of concurrent tasks.
 * Screening 60 tickers with unbounded Promise.all would open 60 simultaneous
 * connections to the data provider and invite rate limiting.
 */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function run() {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        results[i] = { error: err.message, item: items[i] };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}
