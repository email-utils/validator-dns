// A fake DNS for the tests to mock node:dns and node:dns/promises with. It
// answers on the microtask queue, as a real resolver answers after a tick.
import type { DnsResolver } from '../src';

export type RecordType = 'MX' | 'A' | 'AAAA' | 'TXT' | 'NS';

/**
 * A record set, or the error code the lookup fails with; `null` fails it
 * with an error that has no code, and `'silent'` never answers.
 */
export type Answer = readonly unknown[] | { error: string | null } | 'silent';

/** The zone: each domain's answers by record type. */
export const zone: Map<string, Partial<Record<RecordType, Answer>>> = new Map();

/** Every lookup made, as `TYPE domain`. */
export const queries: string[] = [];

export function reset(): void {
  zone.clear();
  queries.length = 0;
}

export const mx = (...exchanges: string[]): Answer =>
  exchanges.map((exchange, i) => ({ exchange, priority: (i + 1) * 10 }));

/** The records set for `domain`, taken as what the test says they are. */
function answer<T>(domain: string, type: RecordType): Promise<T[]> {
  queries.push(`${type} ${domain}`);
  const records = zone.get(domain);
  const found = records?.[type];
  return new Promise((resolve, reject) => {
    if (found === 'silent') {
      return;
    }
    queueMicrotask(() => {
      if (found !== undefined && !('error' in found)) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        resolve([...found] as T[]);
        return;
      }
      const code =
        found === undefined
          ? records === undefined
            ? 'ENOTFOUND'
            : 'ENODATA'
          : found.error;
      const error = new Error(`query${type} ${code ?? 'failed'} ${domain}`);
      reject(code === null ? error : Object.assign(error, { code }));
    });
  });
}

/** The node:dns/promises functions validator-dns uses, and its resolver. */
export const promises: DnsResolver = {
  resolveMx: (domain: string) => answer(domain, 'MX'),
  resolve4: (domain: string) => answer(domain, 'A'),
  resolve6: (domain: string) => answer(domain, 'AAAA'),
  resolveTxt: (domain: string) => answer(domain, 'TXT'),
};

/** node:dns's callback `resolve`, which the 0.0.1 validator uses. */
export const callbacks: {
  resolve: (
    domain: string,
    type: RecordType,
    callback: (err: Error | null, value?: unknown) => void,
  ) => void;
} = {
  resolve: (
    domain: string,
    type: RecordType,
    callback: (err: Error | null, value?: unknown) => void,
  ) => {
    answer(domain, type).then(
      (value) => callback(null, value),
      (err: Error) => callback(err),
    );
  },
};
