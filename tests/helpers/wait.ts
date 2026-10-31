export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  for (let waited = 0; !condition(); waited += 5) {
    if (waited >= timeoutMs) throw new Error(`condition not met within ${timeoutMs} ms`);
    await sleep(5);
  }
}
