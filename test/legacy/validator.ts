// The 0.0.1 validator, kept verbatim for the tests only: the regression
// suite checks what it returned. v1 replaced it with checkDns and isValidDns
// (validator-dns#7).
import * as dns from 'node:dns';
import type { MxRecord } from 'node:dns';
import * as net from 'node:net';
import type { DnsConfig, DnsParam } from './types';

class EmailDnsValidator {
  defaultConfig: DnsConfig = {
    a: 1,
    ns: 100,
    spf: 10,
    mx: 100,
    port: 10,
    validScore: 310,
    smtpPorts: [25, 465, 587],
  };
  // Add in domain allow list.
  config: DnsConfig = this.defaultConfig;
  email = '';
  domain = '';

  constructor(configParam: DnsParam = {}) {
    Object.assign(this.config, configParam);
  }
  private async validateDNS(): Promise<boolean> {
    let dnsValidationFail = false;

    let score = 0;
    const promises: Promise<void>[] = [];

    if (this.config.ns !== -1) {
      promises.push(
        this.getNsRecord()
          .then((addresses) => {
            if (addresses.length) {
              score += this.config.ns;
            }
          })
          .catch(() => {
            dnsValidationFail = true;
          }),
      );
    }

    if (this.config.mx !== -1) {
      // Grab MX records.
      promises.push(
        this.getMxRecord()
          .then((addresses) => {
            if (addresses.length) {
              score += this.config.mx;
              if (this.config.port !== -1) {
                // Check ports on MX records.
                for (const port of this.config.smtpPorts) {
                  for (const { exchange: host } of addresses) {
                    // 0.0.1 behavior, bug included: these are pushed after
                    // Promise.all below has already read the array, so they
                    // are never awaited (validator-dns#7).
                    promises.push(
                      this.isPortReachable(port, { host }).then((reachable) => {
                        if (reachable) {
                          score += this.config.port;
                        }
                      }),
                    );
                  }
                }
              }
            }
          })
          .catch(() => {
            dnsValidationFail = true;
          }),
      );
    }

    if (this.config.spf !== -1) {
      // Grab TXT records and check for spf.
      promises.push(
        this.getTxtRecord()
          .then((records) => {
            for (const chunks of records) {
              // 0.0.1 behavior, bug included: `chunks` is the record's string
              // array, so this only matches a chunk that is exactly 'spf'
              // (validator-dns#7).
              if (chunks.indexOf('spf') !== -1) {
                score += this.config.spf;
                break;
              }
            }
          })
          .catch(() => {}),
      );
    }

    if (this.config.a !== -1) {
      promises.push(
        this.getARecord()
          .then((addresses) => {
            if (addresses.length) {
              score += this.config.a;
            }
          })
          .catch(() => {}),
      );
    }

    await Promise.all(promises);

    if (dnsValidationFail) {
      return false;
    }

    return this.config.validScore <= score;
  }

  private getNsRecord(): Promise<string[]> {
    return new Promise((resolve, reject) => {
      dns.resolve(this.domain, 'NS', (err, addresses) =>
        err ? reject(err) : resolve(addresses),
      );
    });
  }

  private getARecord(): Promise<string[]> {
    return new Promise((resolve, reject) => {
      dns.resolve(this.domain, 'A', (err, addresses) =>
        err ? reject(err) : resolve(addresses),
      );
    });
  }

  private getMxRecord(): Promise<MxRecord[]> {
    return new Promise((resolve, reject) => {
      dns.resolve(this.domain, 'MX', (err, addresses) =>
        err ? reject(err) : resolve(addresses),
      );
    });
  }

  private getTxtRecord(): Promise<string[][]> {
    return new Promise((resolve, reject) => {
      dns.resolve(this.domain, 'TXT', (err, addresses) =>
        err ? reject(err) : resolve(addresses),
      );
    });
  }

  private isPortReachable(
    port: number,
    { host, timeout = 500 }: { host: string; timeout?: number },
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();

      const onError = () => {
        socket.destroy();
        resolve(false);
      };

      socket.setTimeout(timeout);
      socket.once('error', onError);
      socket.once('timeout', onError);

      socket.connect(port, host, () => {
        socket.end();
        resolve(true);
      });
    });
  }

  private setEmailDetails(email: string): boolean {
    if (typeof email !== 'string' || !email) {
      return false;
    }

    this.email = email.trim();
    this.domain = this.email.slice(this.email.indexOf('@') + 1).toLowerCase();
    return true;
  }

  public async validate(email: string): Promise<boolean> {
    if (!this.setEmailDetails(email)) {
      return false;
    }

    return await this.validateDNS();
  }

  private async hasMxMatching(
    email: string,
    pattern: string,
  ): Promise<boolean> {
    if (!this.setEmailDetails(email)) {
      return false;
    }

    try {
      const addresses = await this.getMxRecord();
      return addresses.some(({ exchange }) =>
        exchange.toLowerCase().includes(pattern),
      );
    } catch {
      return false;
    }
  }

  // 0.0.1 behavior: misses Google's newer single MX, smtp.google.com
  // (validator-dns#9).
  public isGSuiteMX(email: string): Promise<boolean> {
    return this.hasMxMatching(email, 'aspmx.l.google.com');
  }

  public isDefaultNamecheapMX(email: string): Promise<boolean> {
    return this.hasMxMatching(email, 'registrar-servers.com');
  }
}

export default EmailDnsValidator;
