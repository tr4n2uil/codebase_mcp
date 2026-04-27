/**
 * Let the event loop run pending I/O (e.g. daemon IPC) before continuing CPU-heavy work
 * in the same Node process.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
