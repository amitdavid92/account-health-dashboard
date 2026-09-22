import { setTimeout as delay } from "node:timers/promises";

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export function providerStatus(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? Number(error.status)
    : undefined;
}

/** One budget shared across all tool-call rounds of a question. */
export async function withChatRetry<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  budget: { remaining: number },
  baseDelayMs = 1000,
): Promise<T> {
  let failures = 0;
  for (;;) {
    signal.throwIfAborted();
    let onAbort: () => void = () => {};
    try {
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      return await Promise.race([operation(), cancelled]);
    } catch (error) {
      signal.throwIfAborted();
      if (!RETRYABLE.has(providerStatus(error) ?? 0) || budget.remaining <= 0) throw error;
      budget.remaining -= 1;
      failures += 1;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    await delay(baseDelayMs * 2 ** (failures - 1) + Math.random() * baseDelayMs / 4, undefined, { signal });
  }
}
