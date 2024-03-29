// VALID EMAIL
// Attempting to follow rules from https://en.wikipedia.org/wiki/Email_address.
// Checks if the email is valid.
import * as dns from 'dns'
import { MxRecord } from 'dns'
import * as net from 'net'

class EmailDnsValidator {
  defaultConfig: DnsConfig = {
    a: 1,
    ns: 100,
    spf: 10,
    mx: 100,
    port: 10,
    validScore: 310,
    smtpPorts: [25, 465, 587],
  }
  // Add in domain allow list.
  config: DnsConfig = this.defaultConfig
  email = ''
  domain = ''

  constructor(configParam: DnsParam = {} as DnsParam) {
    let key: keyof DnsParam

    for (key in configParam) {
      this.config[key] = configParam[key] as number & number[]
    }
  }
  private async validateDNS(): Promise<boolean> {
    let dnsValidationFail = false

    let score = 0
    const promises = []

    if (this.config.ns !== -1) {
      promises.push(
        this.getNsRecord()
          .then((addresses) => {
            if (addresses.length) {
              score += this.config.ns
            }
          })
          .catch((err) => {
            dnsValidationFail = true
            console.error('ERROR GETTING NS: ', err)
          })
      )
    }

    if (this.config.mx !== -1) {
      // Grab MX records.
      promises.push(
        this.getMxRecord()
          .then((addresses) => {
            if (addresses.length) {
              score += this.config.mx
              if (this.config.port !== -1) {
                // Check ports on MX records.
                for (let p = 0; p < this.config.smtpPorts.length; p++) {
                  const port = this.config.smtpPorts[p]
                  for (let a = 0; a < addresses.length; a++) {
                    const host = addresses[a].exchange

                    promises.push(
                      this.isPortReachable(port, { host })
                        .then((reachable) => {
                          if (reachable) {
                            score += this.config.port
                          }
                        })
                        .catch((err) =>
                          console.error('ERROR REACHING PORT: ', err)
                        )
                    )
                  }
                }
              }
            }
          })
          .catch((err) => {
            dnsValidationFail = true
            console.error('ERROR GETTING MX: ', err)
          })
      )
    }

    if (this.config.spf !== -1) {
      // Grab TXT records and check for spf.
      promises.push(
        this.getTxtRecord()
          .then((addresses) => {
            for (let a = 0; a < addresses.length; a++) {
              const address = addresses[a]

              if (address.indexOf('spf') !== -1) {
                score += this.config.spf
                break
              }
            }
          })
          .catch((err) => {
            console.error('ERROR GETTING TXT: ', err)
          })
      )
    }

    if (this.config.a !== -1) {
      promises.push(
        this.getARecord()
          .then((addresses) => {
            if (addresses.length) {
              score += this.config.a
            }
          })
          .catch((err) => {
            console.error('ERROR GETTING A: ', err)
          })
      )
    }

    await Promise.all(promises)

    if (dnsValidationFail) {
      return false
    }

    if (this.config.validScore <= score) {
      return true
    } else {
      return false
    }
  }

  private async getNsRecord(): Promise<string[]> {
    return new Promise((resolve, reject) => {
      if (dns) {
        dns.resolve(this.domain, 'NS', async (err, addresses) => {
          if (err) {
            console.error(this.domain, ' has no NS')
            reject()
          } else if (addresses) {
            resolve(addresses)
          } else {
            reject()
          }
        })
      } else {
        console.error('"dns" is undefined.')
        reject()
      }
    })
  }

  private async getARecord(): Promise<string[]> {
    return new Promise((resolve, reject) => {
      if (dns) {
        dns.resolve(this.domain, 'A', async (err, addresses) => {
          if (err) {
            console.error(this.domain, ' has no NS')
            reject()
          } else if (addresses) {
            resolve(addresses)
          } else {
            reject()
          }
        })
      } else {
        console.error('"dns" is undefined.')
        reject()
      }
    })
  }

  private async getMxRecord(): Promise<MxRecord[]> {
    return new Promise((resolve, reject) => {
      if (dns) {
        dns.resolve(this.domain, 'MX', async (err, addresses) => {
          if (err) {
            console.error(this.domain, ' has no MX')
            reject()
          } else if (addresses) {
            resolve(addresses)
          } else {
            reject()
          }
        })
      } else {
        console.error('"dns" is undefined.')
        reject()
      }
    })
  }

  private async getTxtRecord(): Promise<string[][]> {
    return new Promise((resolve, reject) => {
      if (dns) {
        dns.resolve(this.domain, 'TXT', async (err, addresses) => {
          if (err) {
            console.error(this.domain, ' has no TXT')
            reject()
          } else if (addresses) {
            resolve(addresses)
          } else {
            reject()
          }
        })
      } else {
        console.error('"dns" is undefined.')
        reject()
      }
    })
  }

  private async isPortReachable(
    port: number,
    { host, timeout = 500 }: { host: string; timeout?: number }
  ): Promise<boolean> {
    const promise = new Promise((resolve, reject) => {
      if (net) {
        const socket = new net.Socket()

        const onError = () => {
          socket.destroy()
          reject()
        }

        socket.setTimeout(timeout)
        socket.once('error', onError)
        socket.once('timeout', onError)

        socket.connect(port, host, () => {
          socket.end()
          resolve(true)
        })
      } else {
        console.error('"net" is undefined.')
        reject()
      }
    })

    try {
      await promise
      return true
    } catch {
      return false
    }
  }

  private setEmailDetails(email: string) {
    if (typeof email !== 'string') {
      console.error('Email not a string.', email)
      return false
    } else if (!email) {
      console.error('Email not provided.', email)
      return false
    }

    this.email = email.trim()
    this.domain = this.email.slice(this.email.indexOf('@') + 1).toLowerCase()
  }

  public async validate(email: string): Promise<boolean> {
    const setEmailResults = this.setEmailDetails(email)

    if (setEmailResults === false) {
      return false
    }

    return await this.validateDNS()
  }

  public async isGSuiteMX(email: string) {
    const setEmailResults = this.setEmailDetails(email)

    if (setEmailResults === false) {
      return false
    }

    let isGSuite = false

    try {
      const addresses = await this.getMxRecord()

      if (addresses) {
        for (let a = 0; a < addresses.length; a++) {
          const address = addresses[a]

          const domain = address.exchange.toLowerCase()

          if (domain.indexOf('aspmx.l.google.com') !== -1) {
            isGSuite = true
          }
        }
      }
    } catch (getMxRecordErr) {
      console.error('ERROR GETTING MX in isGSuiteMX: ', getMxRecordErr)
    }

    return isGSuite
  }
  public async isDefaultNamecheapMX(email: string) {
    const setEmailResults = this.setEmailDetails(email)

    if (setEmailResults === false) {
      return false
    }

    let isDefaultNamecheapMX = false

    try {
      const addresses = await this.getMxRecord()

      if (addresses) {
        for (let a = 0; a < addresses.length; a++) {
          const address = addresses[a]

          const domain = address.exchange.toLowerCase()

          if (domain.indexOf('registrar-servers.com') !== -1) {
            isDefaultNamecheapMX = true
          }
        }
      }
    } catch (getMxRecordErr) {
      console.error(
        'ERROR GETTING MX in isDefaultNamecheapMX: ',
        getMxRecordErr
      )
    }

    return isDefaultNamecheapMX
  }
}

export default EmailDnsValidator
