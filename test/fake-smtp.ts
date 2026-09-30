// SMTP servers on the loopback for the probes to talk to. Each one answers
// by a script: what to do on connecting, and on each line it's sent.
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach } from 'vitest';

export interface Script {
  /** What to do once connected: write a greeting, or nothing, or hang up. */
  connect?: (socket: Socket) => void;
  /** What to do with each line the client sends. */
  line?: (line: string, socket: Socket) => void;
}

/** A server that talks as a mail server should. */
export const polite: Required<Script> = {
  connect: (socket) => socket.write('220 mx.example.com ESMTP\r\n'),
  line: (line, socket) => {
    if (line.startsWith('EHLO ')) {
      socket.write('250-mx.example.com\r\n250 SIZE 35882577\r\n');
    } else if (line === 'QUIT') {
      socket.end('221 Bye\r\n');
    }
  },
};

export interface FakeSmtp {
  port: number;
  /** Every line clients sent. */
  lines: string[];
  /** Resolves once every connection has closed. */
  closed(): Promise<void>;
}

const servers: { server: Server; open: Set<Socket> }[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      async ({ server, open }) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          for (const socket of open) {
            socket.destroy();
          }
        }),
    ),
  );
});

/** Listens on `host` at `port`, or a free one, answering by `script`. */
export async function smtp(
  script: Script = polite,
  host = '127.0.0.1',
  port = 0,
): Promise<FakeSmtp> {
  const lines: string[] = [];
  const open = new Set<Socket>();
  let idle: (() => void) | undefined;
  const server = createServer((socket) => {
    open.add(socket);
    socket.on('close', () => {
      open.delete(socket);
      if (open.size === 0) {
        idle?.();
      }
    });
    socket.on('error', () => {});
    let buffer = '';
    socket.setEncoding('latin1');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (
        let end = buffer.indexOf('\r\n');
        end !== -1;
        end = buffer.indexOf('\r\n')
      ) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        lines.push(line);
        script.line?.(line, socket);
      }
    });
    script.connect?.(socket);
  });
  servers.push({ server, open });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP address');
  }
  return {
    port: address.port,
    lines,
    closed: async () =>
      open.size === 0
        ? undefined
        : new Promise<void>((resolve) => {
            idle = resolve;
          }),
  };
}

/** A port nothing listens on. */
export async function closedPort(): Promise<number> {
  const { port } = await smtp();
  await new Promise<void>((resolve) =>
    servers.pop()?.server.close(() => resolve()),
  );
  return port;
}
