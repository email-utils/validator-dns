// MX hosts matched against the classifier's provider registry. The patterns
// are classifier data; resolving the MX to match them is the DNS side.
import { type ProviderId, providers } from '@email-utils/classifier/providers';

interface Index {
  /** Patterns that name one host. */
  exact: Map<string, ProviderId>;
  /** The base of each `*.` pattern, which matches one or more labels. */
  under: Map<string, ProviderId>;
  /** The longest base in `under`: no longer parent can match. */
  longest: number;
}

let index: Index | undefined;

function build(): Index {
  const built: Index = { exact: new Map(), under: new Map(), longest: 0 };
  for (const { id, mxPatterns } of providers) {
    for (const pattern of mxPatterns) {
      if (pattern.startsWith('*.')) {
        const base = pattern.slice(2);
        built.under.set(base, id);
        built.longest = Math.max(built.longest, base.length);
      } else {
        built.exact.set(pattern, id);
      }
    }
  }
  return built;
}

/** The provider whose MX patterns `host` matches, if any. */
function providerOf(
  host: string,
  { exact, under, longest }: Index,
): ProviderId | undefined {
  const id = exact.get(host);
  if (id !== undefined) {
    return id;
  }
  // Each parent of the host, nearest first: a.b.example.com tries
  // b.example.com, example.com, then com. Parents longer than every base
  // are skipped, since looking each up would hash it: with them, a host of
  // many labels took time quadratic in its length (validator-dns#11).
  for (
    let dot = host.indexOf('.', host.length - longest - 1);
    dot !== -1;
    dot = host.indexOf('.', dot + 1)
  ) {
    const parent = under.get(host.slice(dot + 1));
    if (parent !== undefined) {
      return parent;
    }
  }
  return undefined;
}

/**
 * The provider of the first of `mxHosts`, in preference order, that the
 * registry knows.
 */
export function matchProvider(
  mxHosts: readonly string[],
): ProviderId | undefined {
  index ??= build();
  for (const host of mxHosts) {
    const id = providerOf(host, index);
    if (id !== undefined) {
      return id;
    }
  }
  return undefined;
}
