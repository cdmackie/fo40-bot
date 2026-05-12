// Retry-with-backoff wrapper for transient failures (mostly Reddit's
// outbound-HTTP gateway returning "too many requests" - see the README's
// note on the discord.com throttle).
//
// Returns the resolved value on success; throws the LAST error if every
// attempt fails. The caller is responsible for deciding what counts as
// retriable - this wrapper retries on ANY thrown error.
export async function withRetry<T>(
  fn: () => Promise<T>,
  delaysMs: number[],
  context: string,
): Promise<T> {
  let lastErr: unknown;
  const totalAttempts = delaysMs.length + 1;
  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === totalAttempts) break;
      const wait = delaysMs[attempt - 1];
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[fo40-bridge] ${context} attempt ${attempt}/${totalAttempts} failed; retrying in ${wait}ms: ${msg}`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}
