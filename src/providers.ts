// MX hosts matched against the classifier's provider registry. The patterns
// are classifier data; resolving the MX to match them is the DNS side.
import { type ProviderId, providers } from '@email-utils/classifier/providers';

interface Index {
  /** Patterns that name one host. */
  exact: Map<string, ProviderId>;
  /** The base of each `*.` pattern, which matches one or more labels. */
  under: Map<string, ProviderId>;
}

let index: Index | undefined;

function build(): Index {
  const built: Index = { exact: new Map(), under: new Map() };
  for (const { id, mxPatterns } of providers) {
    for (const pattern of mxPatterns) {
      const [map, key] = pattern.startsWith('*.')
        ? [built.under, pattern.slice(2)]
        : [built.exact, pattern];
      map.set(key, id);
    }
  }
  return built;
}

/** The provider whose MX patterns `host` matches, if any. */
function providerOf(
  host: string,
  { exact, under }: Index,
): ProviderId | undefined {
  const id = exact.get(host);
  if (id !== undefined) {
    return id;
  }
  // Each parent of the host, nearest first: a.b.example.com tries
  // b.example.com, example.com, then com.
  for (
    let dot = host.indexOf('.');
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
