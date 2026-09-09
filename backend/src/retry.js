// Retry engine: exponential backoff with jitter + error classification.
// Used to wrap OpenSearch fetches and ClickHouse inserts.

// Retryable = transient infrastructure problems worth waiting out.
// Non-retryable = permanent problems (bad data, bad auth, bad query) — fail fast.
function classifyError(err) {
  const msg = (err && err.message ? err.message : String(err)).toLowerCase();

  // Network-level transient failures
  const transientNet = [
    'etimedout', 'econnreset', 'econnrefused', 'esockettimedout',
    'socket hang up', 'network', 'timeout', 'and retry', 'eai_again', 'enotfound',
  ];
  if (transientNet.some(s => msg.includes(s))) return { retryable: true, category: 'network' };

  // HTTP status codes embedded in the thrown message (services throw "error 503: ...")
  const m = msg.match(/\b(4\d\d|5\d\d)\b/);
  if (m) {
    const code = parseInt(m[1], 10);
    // Retryable server / throttling responses
    if ([429, 500, 502, 503, 504].includes(code)) return { retryable: true, category: 'server' };
    // Auth / permission — permanent
    if ([401, 403].includes(code)) return { retryable: false, category: 'auth' };
    // Bad request / not found / unprocessable — permanent (usually bad data or schema)
    if ([400, 404, 409, 422].includes(code)) return { retryable: false, category: 'data' };
  }

  // OpenSearch circuit breaker — JVM heap exhausted. Marked PERMANENT by OS; retrying
  // just hammers an already-OOM'd node and makes things worse.
  if (msg.includes('circuit_breaking_exception') || msg.includes('data too large') ||
      msg.includes('reduce_aggs')) {
    return { retryable: false, category: 'circuit_breaker' };
  }

  // ClickHouse parse/type errors are permanent data problems
  if (msg.includes('cannot parse') || msg.includes('type_mismatch') ||
      msg.includes('unknown identifier') || msg.includes('no such column')) {
    return { retryable: false, category: 'data' };
  }

  // Default: treat unknown errors as retryable once or twice rather than losing data,
  // but mark category unknown so the caller can decide.
  return { retryable: true, category: 'unknown' };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Run `fn` with exponential backoff + jitter.
 * opts: { maxAttempts, initialDelayMs, maxDelayMs, onRetry(attempt, delay, err) }
 * Throws the last error (with .category attached) if all attempts fail or the error is non-retryable.
 */
async function withRetry(fn, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 5;
  const initial = opts.initialDelayMs ?? 1000;
  const max = opts.maxDelayMs ?? 30000;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;
    try {
      return await fn();
    } catch (err) {
      const { retryable, category } = classifyError(err);
      err.category = category;
      err.retryable = retryable;

      if (!retryable || attempt >= maxAttempts) {
        err.attempts = attempt;
        throw err;
      }

      // Exponential backoff: initial * 2^(attempt-1), capped, plus up to 30% jitter.
      const base = Math.min(initial * Math.pow(2, attempt - 1), max);
      const jitter = base * 0.3 * Math.random();
      const delay = Math.round(base + jitter);

      if (opts.onRetry) opts.onRetry(attempt, delay, err);
      await sleep(delay);
    }
  }
}

module.exports = { withRetry, classifyError, sleep };
