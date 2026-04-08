// In-memory rate limiter for Vercel serverless functions.
// Map persists while the function instance stays warm, providing
// protection against rapid abuse. Resets on cold start — acceptable
// for this use case. For stricter enforcement, swap in Redis/Upstash.

const buckets = new Map();

const CLEANUP_INTERVAL = 60_000; // purge stale entries every 60s
let lastCleanup = Date.now();

function cleanup(windowMs) {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL) return;
  lastCleanup = now;
  for (const [key, entry] of buckets) {
    if (now - entry.start > windowMs * 2) buckets.delete(key);
  }
}

/**
 * Create a rate-limit guard for a specific route.
 *
 * @param {object} opts
 * @param {number} opts.maxRequests  — allowed requests per window
 * @param {number} opts.windowMs     — window size in ms (default 60 000)
 * @returns {function(req, res): boolean} — returns true if request is blocked
 */
export function rateLimit({ maxRequests, windowMs = 60_000 }) {
  return function check(req, res) {
    cleanup(windowMs);

    // Identify caller by IP (works on Vercel + Express)
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.headers["x-real-ip"] ||
      req.socket?.remoteAddress ||
      "unknown";

    const routeKey = req.url || req.path || "/";
    const key = `${ip}::${routeKey}`;
    const now = Date.now();

    let entry = buckets.get(key);
    if (!entry || now - entry.start > windowMs) {
      entry = { count: 1, start: now };
      buckets.set(key, entry);
      setRateLimitHeaders(res, maxRequests, maxRequests - 1, windowMs, entry.start);
      return false; // allowed
    }

    entry.count++;

    if (entry.count > maxRequests) {
      const retryAfter = Math.ceil((entry.start + windowMs - now) / 1000);
      setRateLimitHeaders(res, maxRequests, 0, windowMs, entry.start);
      res.setHeader("Retry-After", retryAfter);
      res.status(429).json({
        error: "Too many requests. Please slow down.",
        retryAfterSeconds: retryAfter,
      });
      return true; // blocked
    }

    setRateLimitHeaders(res, maxRequests, maxRequests - entry.count, windowMs, entry.start);
    return false; // allowed
  };
}

function setRateLimitHeaders(res, limit, remaining, windowMs, windowStart) {
  res.setHeader("X-RateLimit-Limit", limit);
  res.setHeader("X-RateLimit-Remaining", Math.max(0, remaining));
  res.setHeader("X-RateLimit-Reset", Math.ceil((windowStart + windowMs) / 1000));
}
