import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

/** Issues short-lived HMAC-SHA1 Coturn REST credentials with in-memory rate limiting. */
export function createTurnCredentialHandler({
  secret = '',
  urls = [],
  ttl = 21600,
  maxPerIp = 24,
  windowMs = 600_000,
  trustProxy = false,
} = {}) {
  const perIp = new Map();
  let globalBucket = { count: 0, resetAt: Date.now() + windowMs };

  return (request) => {
    if (request.headers?.['x-p2sharer-client'] !== '1') {
      return { status: 403, body: { error: 'Client verification required' } };
    }
    if (!secret || !Array.isArray(urls) || urls.length === 0) {
      return { status: 200, body: { enabled: false, urls: [] } };
    }

    const now = Date.now();
    for (const [key, entry] of perIp) {
      if (now >= entry.resetAt) perIp.delete(key);
    }
    if (now >= globalBucket.resetAt) {
      globalBucket = { count: 0, resetAt: now + windowMs };
    }

    const forwardedHeader = request.headers?.['x-forwarded-for'];
    const rawForwarded = Array.isArray(forwardedHeader) ? forwardedHeader[0] : forwardedHeader;
    const forwarded = trustProxy ? rawForwarded?.split(',')[0]?.trim() : null;
    const address = forwarded && isIP(forwarded) ? forwarded : request.socket?.remoteAddress ?? 'unknown';

    let entry = perIp.get(address);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
    }
    if (entry.count >= maxPerIp || globalBucket.count >= maxPerIp * 32) {
      return { status: 429, body: { error: 'Rate limit exceeded' } };
    }

    entry.count += 1;
    perIp.set(address, entry);
    globalBucket.count += 1;

    const expiresAt = Math.floor(now / 1000) + ttl;
    const username = `${expiresAt}:p2s-${randomBytes(4).toString('hex')}`;
    const credential = createHmac('sha1', secret).update(username).digest('base64');
    return { status: 200, body: { enabled: true, urls, username, credential, ttl } };
  };
}
