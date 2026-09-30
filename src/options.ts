import {
  createSyntaxValidator,
  type SyntaxOptions,
  type SyntaxValidator,
} from '@email-utils/validator-syntax';

/** Options for {@link checkDns} and {@link isValidDns}. */
export interface DnsOptions {
  /**
   * How an address or domain is parsed before any lookup. `allowIdn` is on
   * unless you turn it off or pick the `html5` preset, which can't hold IDN
   * domains.
   *
   * @defaultValue the validator-syntax `practical` preset with `allowIdn`
   */
  syntax?: SyntaxOptions | undefined;
}

/** Options checked once, for every call that shares them. */
export interface Rules {
  syntax: SyntaxValidator;
}

/**
 * Checks `options` and resolves them into {@link Rules}.
 *
 * @throws TypeError when `options` are malformed.
 */
export function resolve(options: DnsOptions = {}): Rules {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('Expected `options` to be an object');
  }
  const { syntax = {} } = options;
  // Anything but an object goes through as is, so validator-syntax throws
  // its own TypeError for it.
  if (typeof syntax !== 'object' || syntax === null) {
    return { syntax: createSyntaxValidator(syntax) };
  }
  return {
    syntax: createSyntaxValidator(
      syntax.preset === 'html5' ? syntax : { allowIdn: true, ...syntax },
    ),
  };
}
