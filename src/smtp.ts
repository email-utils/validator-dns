// SMTP port probes: connect to each MX host, read the greeting, send EHLO,
// and QUIT. No MAIL or RCPT is ever sent, so a probe learns whether a mail
// server answers, never whether a mailbox exists.
import { connect as connectTcp, isIP, isIPv6, type Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';

/**
 * How far a probe got: `accepted` once the server greets with 220 and
 * answers EHLO with 250; `refused` when it replies with anything else or
 * hangs up; `unreachable` when nothing takes the connection; `timeout` when
 * the probe runs out of time.
 */
export type SmtpOutcome = 'accepted' | 'refused' | 'unreachable' | 'timeout';

/** One probe of one MX host on one port. */
export interface SmtpPortProbe {
  host: string;
  port: number;
  outcome: SmtpOutcome;
  /** The last reply's code: EHLO's, or the greeting's. Absent without one. */
  code?: number;
  /** What happened, for people. Not semver-stable. */
  message?: string;
}

/** Every probe of a domain's MX hosts. */
export interface SmtpProbe {
  /** Some probe was `accepted`. */
  accepted: boolean;
  /**
   * Each host in preference order, and each port in turn for each host.
   * With `untilAccepted`, only the hosts tried.
   */
  probes: SmtpPortProbe[];
}

/** What a probe is held to. */
export interface ProbeRules {
  ports: readonly number[];
  /** The EHLO name; the local end's address literal when `undefined`. */
  ehloName: string | undefined;
  timeout: number;
  untilAccepted: boolean;
}

// Ports that speak TLS from the first byte (RFC 8314 §3.3).
const implicitTls = new Set([465]);

// Connection errors that mean nothing took the connection.
const unreachable = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  'EAI_NONAME',
]);

// A server that sends more than this without ending a reply isn't talking
// SMTP (RFC 5321 §4.5.3.1.5 caps a reply line at 512 octets).
const maxBuffered = 64 * 1024;

/** The address literal for `address` (RFC 5321 §4.1.3). */
function literal(address: string | undefined): string {
  if (address === undefined) {
    return '[127.0.0.1]';
  }
  const bare = address.replace(/^::ffff:(?=\d+\.)/i, '');
  return isIPv6(bare) ? `[IPv6:${bare}]` : `[${bare}]`;
}

function codeOf(error: unknown): string | undefined {
  const code: unknown =
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Reads SMTP replies from the lines a server sends: a reply is lines
 * starting with the same three digits, `-` after them on every line but
 * the last (RFC 5321 §4.2.1).
 */
class Replies {
  #buffer = '';

  /** The next whole reply's code, `NaN` for a malformed one, or `undefined` for none yet. */
  next(): number | undefined {
    for (;;) {
      const end = this.#buffer.indexOf('\n');
      if (end === -1) {
        return undefined;
      }
      const line = this.#buffer.slice(0, end).replace(/\r$/, '');
      this.#buffer = this.#buffer.slice(end + 1);
      const match = /^(\d{3})([ -]|$)/.exec(line);
      if (match === null) {
        return Number.NaN;
      }
      if (match[2] !== '-') {
        return Number(match[1]);
      }
    }
  }

  push(chunk: string): boolean {
    this.#buffer += chunk;
    return this.#buffer.length <= maxBuffered;
  }
}

/**
 * Probes `host` on `port`: connect, greeting, EHLO, QUIT. Never rejects;
 * when `signal` aborts, it closes the connection and settles as `timeout`.
 */
export async function probePort(
  host: string,
  port: number,
  rules: Readonly<ProbeRules>,
  signal: AbortSignal,
): Promise<SmtpPortProbe> {
  return new Promise((resolve) => {
    const socket: Socket = implicitTls.has(port)
      ? // A probe checks that a server answers, not who it is: many MX
        // certificates don't match the MX host, and nothing secret is sent.
        connectTls({
          host,
          port,
          // SNI takes host names only (RFC 6066 §3).
          ...(isIP(host) === 0 ? { servername: host } : {}),
          rejectUnauthorized: false,
        })
      : connectTcp({ host, port });
    socket.setEncoding('latin1');
    const replies = new Replies();
    let code: number | undefined;
    let stage: 'greeting' | 'ehlo' = 'greeting';

    const finish = (
      outcome: SmtpOutcome,
      message: string,
      quit = false,
    ): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      socket.removeAllListeners();
      // A late error from a closing connection has nowhere to go.
      socket.on('error', () => {});
      if (quit) {
        socket.end('QUIT\r\n', () => socket.destroy());
      } else {
        socket.destroy();
      }
      resolve({
        host,
        port,
        outcome,
        ...(code === undefined ? {} : { code }),
        message,
      });
    };

    const onAbort = (): void => finish('timeout', 'The probe was aborted');
    const timer = setTimeout(() => {
      finish(
        'timeout',
        `No ${stage === 'greeting' ? 'greeting' : 'reply to EHLO'} in ${rules.timeout} ms`,
      );
    }, rules.timeout);
    signal.addEventListener('abort', onAbort, { once: true });

    socket.on('data', (chunk: string) => {
      if (!replies.push(chunk)) {
        finish('refused', 'The server sent too much without a reply');
        return;
      }
      for (
        let reply = replies.next();
        reply !== undefined;
        reply = replies.next()
      ) {
        if (Number.isNaN(reply)) {
          finish('refused', 'The server sent a malformed reply');
          return;
        }
        code = reply;
        if (stage === 'greeting') {
          if (reply !== 220) {
            finish('refused', `The server greeted with ${reply}`, true);
            return;
          }
          stage = 'ehlo';
          socket.write(
            `EHLO ${rules.ehloName ?? literal(socket.localAddress)}\r\n`,
          );
        } else {
          if (reply === 250) {
            finish('accepted', 'The server answered EHLO with 250', true);
          } else {
            finish('refused', `The server answered EHLO with ${reply}`, true);
          }
          return;
        }
      }
    });
    socket.on('error', (error) => {
      const errorCode = codeOf(error);
      if (errorCode === 'ETIMEDOUT') {
        finish('timeout', 'The connection timed out');
      } else if (errorCode !== undefined && unreachable.has(errorCode)) {
        finish('unreachable', `The connection failed with ${errorCode}`);
      } else {
        finish(
          'refused',
          `The connection failed${errorCode === undefined ? '' : ` with ${errorCode}`}`,
        );
      }
    });
    socket.on('close', () => {
      finish(
        'refused',
        `The server hung up before ${stage === 'greeting' ? 'a greeting' : 'answering EHLO'}`,
      );
    });
  });
}

/** Probes `host` on every port in `rules` at once. */
async function probeHost(
  host: string,
  rules: Readonly<ProbeRules>,
  signal: AbortSignal,
): Promise<SmtpPortProbe[]> {
  return Promise.all(
    rules.ports.map(async (port) => probePort(host, port, rules, signal)),
  );
}

/**
 * Probes every one of `hosts` on every port in `rules` at once, and waits
 * for them all; or, with `untilAccepted`, one host at a time until one
 * accepts.
 */
export async function probeHosts(
  hosts: readonly string[],
  rules: Readonly<ProbeRules>,
  signal: AbortSignal,
): Promise<SmtpProbe> {
  let probes: SmtpPortProbe[] = [];
  if (rules.untilAccepted) {
    for (const host of hosts) {
      // One host after another is the point.
      // oxlint-disable-next-line no-await-in-loop
      const tried = await probeHost(host, rules, signal);
      probes.push(...tried);
      if (
        signal.aborted ||
        tried.some(({ outcome }) => outcome === 'accepted')
      ) {
        break;
      }
    }
  } else {
    probes = (
      await Promise.all(
        hosts.map(async (host) => probeHost(host, rules, signal)),
      )
    ).flat();
  }
  return {
    accepted: probes.some(({ outcome }) => outcome === 'accepted'),
    probes,
  };
}
