/** Runs at most `max` tasks at once; the rest wait in FIFO order. */
export function createLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  const release = (): void => {
    active--;
    waiting.shift()?.();
  };
  return async (task) => {
    if (active >= max) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await task();
    } finally {
      release();
    }
  };
}
