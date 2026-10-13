import lockfile from "proper-lockfile";
import { setTimeout } from "node:timers/promises";

export async function withFileLock<T>(
  resourcePath: string,
  operation: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const compromised = new AbortController();
  const activeSignal = signal ? AbortSignal.any([signal, compromised.signal]) : compromised.signal;
  const deadline = Date.now() + 120_000;
  let release: () => Promise<void>;

  // shortcut: cooperative leases on local filesystems; use fencing if arbitrary process suspension must be safe.
  for (;;) {
    activeSignal.throwIfAborted();
    try {
      release = await lockfile.lock(resourcePath, {
        realpath: false,
        retries: 0,
        stale: 30_000,
        update: 10_000,
        onCompromised: (error) => compromised.abort(error),
      });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for reference lock: ${resourcePath}`);
      await setTimeout(100, undefined, { signal: activeSignal });
    }
  }

  let failed = false;
  try {
    activeSignal.throwIfAborted();
    const result = await operation(activeSignal);
    compromised.signal.throwIfAborted();
    return result;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      await release();
    } catch (error) {
      if (!failed) throw error;
    }
  }
}
