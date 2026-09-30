// The lookups checks share: an answer is cached for the TTL, and a lookup
// already in flight is joined rather than made again, so a thousand checks
// of one domain make one lookup per record type.
import type { Cache, DnsResolver } from './options';

export type RecordType = 'MX' | 'A' | 'AAAA' | 'TXT';

/** The records each lookup resolves to. */
export interface Answers {
  MX: { exchange: string; priority: number }[];
  A: string[];
  AAAA: string[];
  TXT: string[][];
}

/** A lookup's records, with "no such domain" and "no records" both empty. */
export type Lookup<K extends RecordType> =
  | { ok: true; records: Answers[K] }
  | { ok: false; type: K; code: string | undefined };

const queries: {
  [K in RecordType]: (
    resolver: DnsResolver,
    domain: string,
  ) => Promise<Answers[K]>;
} = {
  MX: (resolver, domain) => resolver.resolveMx(domain),
  A: (resolver, domain) => resolver.resolve4(domain),
  AAAA: (resolver, domain) => resolver.resolve6(domain),
  TXT: (resolver, domain) => resolver.resolveTxt(domain),
};

async function ask<K extends RecordType>(
  resolver: DnsResolver,
  type: K,
  domain: string,
): Promise<Lookup<K>> {
  try {
    return { ok: true, records: await queries[type](resolver, domain) };
  } catch (error) {
    const code: unknown =
      typeof error === 'object' && error !== null && 'code' in error
        ? error.code
        : undefined;
    if (code === 'ENODATA' || code === 'ENOTFOUND') {
      return { ok: true, records: [] };
    }
    return {
      ok: false,
      type,
      code: typeof code === 'string' ? code : undefined,
    };
  }
}

/** A lookup that ran past its budget. */
export function timedOut<K extends RecordType>(type: K): Lookup<K> {
  return { ok: false, type, code: 'ETIMEOUT' };
}

/** Looks up `type` for `domain`, counting it as timed out after `timeout` ms. */
async function lookup<K extends RecordType>(
  resolver: DnsResolver,
  type: K,
  domain: string,
  timeout: number,
): Promise<Lookup<K>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      ask(resolver, type, domain),
      new Promise<Lookup<K>>((resolve) => {
        timer = setTimeout(resolve, timeout, timedOut(type));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

interface Entry<K extends RecordType> {
  answer: Promise<Lookup<K>>;
  /** The answer once it's in, so a cache hit needn't wait a tick for it. */
  settled: Lookup<K> | undefined;
  /** When it leaves the cache; `Infinity` while in flight. */
  expires: number;
}

/** The lookups a validator shares. */
export interface Lookups {
  /**
   * The answer for `type` at `domain`: the cached one, the one in flight,
   * or a new lookup that times out after `timeout` ms.
   */
  get<K extends RecordType>(
    type: K,
    domain: string,
    timeout: number,
  ): Lookup<K> | Promise<Lookup<K>>;
}

/**
 * Lookups through `resolver`, each answer kept for `ttl` ms. Each record
 * type keeps at most `max` answers, dropping the oldest to make room.
 */
export function createLookups(
  { resolver, ttl }: Readonly<Cache>,
  max = 10_000,
): Lookups {
  const caches: { [K in RecordType]: Map<string, Entry<K>> } = {
    MX: new Map(),
    A: new Map(),
    AAAA: new Map(),
    TXT: new Map(),
  };
  return {
    get(type, domain, timeout) {
      const cache = caches[type];
      const cached = cache.get(domain);
      if (cached !== undefined) {
        if (cached.expires > Date.now()) {
          return cached.settled ?? cached.answer;
        }
        cache.delete(domain);
      }
      if (cache.size >= max) {
        // A Map keeps insertion order, so the first key is the oldest.
        for (const oldest of cache.keys()) {
          cache.delete(oldest);
          break;
        }
      }
      const entry: Entry<typeof type> = {
        settled: undefined,
        expires: Infinity,
        answer: lookup(resolver, type, domain, timeout).then((answer) => {
          entry.settled = answer;
          if (answer.ok && ttl > 0) {
            entry.expires = Date.now() + ttl;
          } else if (cache.get(domain) === entry) {
            cache.delete(domain);
          }
          return answer;
        }),
      };
      cache.set(domain, entry);
      return entry.answer;
    },
  };
}
