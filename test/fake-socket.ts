// Scripted sockets for the tests to mock node:net and node:tls `connect`
// with, so a probe talks to a script in memory rather than a server on the
// loopback. Like fake-smtp's servers, each connection answers by a script;
// like a real socket, it answers after a tick, never inside the call.
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';

/** The server's end of a connection, as a script drives it. */
export interface Peer {
  /** Sends `text` to the client. */
  write(text: string): void;
  /** Sends `text`, if given, then hangs up. */
  end(text?: string): void;
  /** Fails the client's connection with an error carrying `code`, if given. */
  fail(code?: string): void;
}

export interface Script {
  /** What to do once connected: write a greeting, or nothing, or hang up. */
  connect?: (peer: Peer) => void;
  /** What to do with each line the client sends. */
  line?: (line: string, peer: Peer) => void;
}

/** A server that talks as a mail server should. */
export const polite: Required<Script> = {
  connect: (peer) => peer.write('220 mx.example.com ESMTP\r\n'),
  line: (line, peer) => {
    if (line.startsWith('EHLO ')) {
      peer.write('250-mx.example.com\r\n250 SIZE 35882577\r\n');
    } else if (line === 'QUIT') {
      peer.end('221 Bye\r\n');
    }
  },
};

export interface Connection {
  host: string;
  port: number;
  /** Every line the client sent. */
  lines: string[];
}

/** Every connection made, in order. */
export const connections: Connection[] = [];

let scriptFor: (host: string, port: number) => Script = () => polite;

/** Answers every connection by `script`, or by the one it picks per host and port. */
export function answer(
  script: Script | ((host: string, port: number) => Script),
): void {
  scriptFor = typeof script === 'function' ? script : () => script;
}

export function reset(): void {
  connections.length = 0;
  scriptFor = () => polite;
}

/** net.connect and tls.connect, in the options form validator-dns calls. */
export function connect({
  host = 'localhost',
  port = 0,
}: {
  host?: string | undefined;
  port?: number | undefined;
}): Socket {
  const connection: Connection = { host, port, lines: [] };
  connections.push(connection);
  const script = scriptFor(host, port);
  let buffer = '';
  let ended = false;
  const socket = new Duplex({
    // A peer that hangs up closes the connection, as a net.Socket does.
    allowHalfOpen: false,
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      buffer += chunk.toString('latin1');
      for (
        let end = buffer.indexOf('\r\n');
        end !== -1;
        end = buffer.indexOf('\r\n')
      ) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        connection.lines.push(line);
        queueMicrotask(() => script.line?.(line, peer));
      }
      callback();
    },
  });
  const peer: Peer = {
    write: (text) => {
      if (!ended && !socket.destroyed) {
        socket.push(text);
      }
    },
    end: (text) => {
      if (text !== undefined) {
        peer.write(text);
      }
      if (!ended && !socket.destroyed) {
        ended = true;
        socket.push(null);
      }
    },
    fail: (code) => {
      const error = new Error(`connect ${code ?? 'failed'} ${host}:${port}`);
      socket.destroy(
        code === undefined ? error : Object.assign(error, { code }),
      );
    },
  };
  queueMicrotask(() => script.connect?.(peer));
  // The probe uses only what a Duplex has; localAddress is left undefined.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return socket as Socket;
}
