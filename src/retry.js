'use strict';
// Telegram-aware retry: waits out FLOOD_WAIT, retries short network hiccups.

const sleepReal = ms => new Promise(r => setTimeout(r, ms));

function floodSeconds(err) {
  if (!err) return null;
  if (typeof err.seconds === 'number' && /FLOOD|wait of/i.test(String(err.errorMessage || err.message || err.constructor?.name))) return err.seconds;
  const m = /FLOOD_(?:PREMIUM_)?WAIT_(\d+)/.exec(String(err.errorMessage || err.message || ''));
  return m ? Number(m[1]) : null;
}

function isTransient(err) {
  const s = String(err && (err.errorMessage || err.code || err.message) || '');
  return /TIMEOUT|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|Not connected|disconnected|Cannot send requests while disconnected|RPC_CALL_FAIL|INTERNAL|-503|No workers running|socket/i.test(s);
}

async function withTelegramRetry(fn, { log, what = 'telegram call', maxAttempts = 6, maxFloodWaitSec = 300, sleep = sleepReal, onDisconnect } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (err && err.notReady) throw err; // telegram not configured/connected yet: fail fast with 503
      const flood = floodSeconds(err);
      if (flood !== null) {
        if (flood > maxFloodWaitSec) {
          log && log.error(`${what}: Telegram asks to wait ${flood}s (over MAX_FLOOD_WAIT_SEC=${maxFloodWaitSec}), giving up`);
          throw err;
        }
        log && log.warn(`${what}: FLOOD_WAIT ${flood}s, waiting (attempt ${attempt})`);
        await sleep(flood * 1000 + 250);
        continue;
      }
      if (isTransient(err) && attempt < maxAttempts) {
        const backoff = Math.min(1000 * 2 ** (attempt - 1), 15000);
        log && log.warn(`${what}: ${err.errorMessage || err.message}; retry in ${backoff}ms`);
        if (onDisconnect) { try { await onDisconnect(err); } catch (_) {} }
        await sleep(backoff);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

class Semaphore {
  constructor(max) { this.max = Math.max(1, max); this.active = 0; this.queue = []; }
  async run(fn) {
    if (this.active >= this.max) await new Promise(r => this.queue.push(r));
    this.active++;
    try { return await fn(); } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
  get busy() { return this.active >= this.max; }
}

module.exports = { withTelegramRetry, floodSeconds, isTransient, Semaphore };
