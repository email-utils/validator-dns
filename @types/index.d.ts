type DnsConfig = {
  a: number // -1 means don't check.
  ns: number // -1 means don't check.
  spf: number // -1 means don't check.
  port: number // -1 means don't check.
  mx: number // -1 means don't check.
  validScore: number // -1 means don't check.
  smtpPorts: number[]
}

type DnsParam = {
  a: number // -1 means don't check.
  ns: number // -1 means don't check.
  spf: number // -1 means don't check.
  port: number // -1 means don't check.
  mx: number // -1 means don't check.
  validScore: number // -1 means don't check.
  smtpPorts: number[]
}