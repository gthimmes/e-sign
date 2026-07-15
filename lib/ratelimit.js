// Tiny in-memory sliding-window rate limiter — no external dependencies.
// Suitable for a single-process local app. Behind a load balancer or multiple
// workers you'd move this to a shared store (Redis) instead.
import { clientIp } from './audit.js';

const buckets = new Map(); // key -> number[] (timestamps, ms)

// Periodically drop empty buckets so the map doesn't grow unbounded.
let lastSweep = 0;
function sweep(now, windowMs) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, hits] of buckets) {
    if (!hits.length || now - hits[hits.length - 1] > windowMs) buckets.delete(key);
  }
}

// Returns middleware allowing at most `max` requests per `windowMs` per key.
// keyFn defaults to client IP + route path, so limits are per-endpoint.
export function rateLimit({ max, windowMs, keyFn, message } = {}) {
  return (req, res, next) => {
    const now = Date.now();
    // Date.now() is fine here (runtime middleware, not a workflow script).
    const key = (keyFn ? keyFn(req) : `${clientIp(req)}:${req.baseUrl}${req.path}`);
    const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
    if (hits.length >= max) {
      const retryMs = windowMs - (now - hits[0]);
      res.setHeader('Retry-After', Math.ceil(retryMs / 1000));
      return res.status(429).json({ error: message || 'Too many requests. Please slow down and try again shortly.' });
    }
    hits.push(now);
    buckets.set(key, hits);
    sweep(now, windowMs);
    next();
  };
}
