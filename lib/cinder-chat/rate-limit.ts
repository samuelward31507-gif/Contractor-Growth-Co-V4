/**
 * A small in-memory limit on the public chat endpoint, so one visitor (or
 * script) cannot run up model usage. Best-effort by design: each server
 * instance counts on its own and counts reset on a cold start - no new
 * datastore is introduced for a marketing-site assistant. The per-instance
 * global cap bounds the worst case even when IPs rotate.
 */
export type RateLimitConfig = { windowMs: number; perClient: number; global: number; maxTrackedClients: number };

export const CHAT_RATE_LIMIT: RateLimitConfig = { windowMs: 10 * 60 * 1000, perClient: 30, global: 600, maxTrackedClients: 5000 };

export function createRateLimiter(config: RateLimitConfig = CHAT_RATE_LIMIT) {
  const clients = new Map<string, number[]>();
  let globalHits: number[] = [];

  return function allow(clientKey: string, now: number = Date.now()): boolean {
    const since = now - config.windowMs;
    globalHits = globalHits.filter((t) => t > since);
    if (globalHits.length >= config.global) return false;

    const hits = (clients.get(clientKey) ?? []).filter((t) => t > since);
    if (hits.length >= config.perClient) {
      clients.set(clientKey, hits);
      return false;
    }
    hits.push(now);
    clients.delete(clientKey);
    clients.set(clientKey, hits);
    globalHits.push(now);
    // Forget the least recently seen clients beyond the cap (Map keeps insertion order).
    while (clients.size > config.maxTrackedClients) clients.delete(clients.keys().next().value as string);
    return true;
  };
}

/** The requesting client's address as the platform reports it; one shared bucket when absent. */
export function clientKeyFrom(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || headers.get("x-real-ip")?.trim() || "unknown";
}
