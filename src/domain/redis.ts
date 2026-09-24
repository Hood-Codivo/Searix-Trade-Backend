import { Redis } from 'ioredis';

let client: InstanceType<typeof Redis> | null = null;

export function isRedisConfigured(): boolean {
  return Boolean(process.env.REDIS_URL?.trim());
}

function getClient(): InstanceType<typeof Redis> | null {
  if (!isRedisConfigured()) return null;
  if (client) return client;
  client = new Redis(process.env.REDIS_URL as string, {
    connectTimeout: 5_000,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });
  client.on('error', (error: Error) => console.error('redis client error', error.message));
  return client;
}

// Cache-aside helper: real caching of Jupiter API responses so a slow/rate-limited external call
// doesn't block every provider poll. Never lets a cache failure break the real fetch -- on any
// Redis error (unreachable, timeout, bad data) it just falls through to `fetchFresh`.
export async function cached<T>(key: string, ttlSeconds: number, fetchFresh: () => Promise<T>): Promise<T> {
  const redis = getClient();
  if (!redis) return fetchFresh();

  try {
    if (redis.status === 'wait') await redis.connect();
    const hit = await redis.get(key);
    if (hit) return JSON.parse(hit) as T;
  } catch (error) {
    console.error('redis read failed, falling back to live fetch', error);
  }

  const fresh = await fetchFresh();

  try {
    if (redis.status === 'ready') await redis.set(key, JSON.stringify(fresh), 'EX', ttlSeconds);
  } catch (error) {
    console.error('redis write failed (non-fatal)', error);
  }

  return fresh;
}
