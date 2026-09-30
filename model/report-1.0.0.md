# Score models 1.0.0

The two models `scoreDns` ships with. Each turns a domain's DNS records
into one number: the chance that one of the domain's mail servers answers
when you connect to it — greets with 220 and replies 250 to EHLO on
port 25.

- `dns-reachability`, the default, uses the DNS signals plus
  `knownProvider`: whether the domain's MX belongs to a provider the
  classifier's registry knows (version 1.0.0-rc.3 when fitted), the
  same match `detectProviderByMx` makes.
- `dns-only` uses the DNS signals alone.

`multipleMx` means the domain has more than one MX host. `implicitMx`
is in neither model: it is always the opposite of `hasMx`.

[METHODOLOGY.md](./METHODOLOGY.md) explains from scratch how the models
are built and what every number below means.

## Corpus

- The domains come from the Tranco list V349N, a ranking of popular
  domains, sampled at random.
- Probed 2026-09-30 from one vantage point: a phone tethered
  on Google Fi, a mobile carrier. Mail servers often distrust mobile and
  home addresses — many sit on lists of addresses that shouldn't send
  mail directly, such as the Spamhaus PBL — so some refusals may say
  more about the vantage point than about the domain. Acceptances are
  unaffected: good reputation can't be faked by a 250 reply, and a bad
  address can't earn one.
- 4937 domains were sampled; 4549 passed `checkDns` and were
  probed, and 2765 of those accepted.
  79 domains only ever answered "try again later" (a 4xx reply,
  usually greylisting) and are left out of the fit, since that answer
  says nothing either way.
- The models were fitted on 80% of the domains (3571). The other
  20% (899, of which 59.1% accepted) were set aside and used
  only for the measurements below, so the numbers show how the models do
  on domains they never saw. A hash of the domain name decides which are
  set aside, so a refit sets aside the same ones.

| Outcome                               | Domains |
| ------------------------------------- | ------- |
| not accepted                          | 1705    |
| dns.domain.not_found                  | 309     |
| accepted                              | 2765    |
| deferred (4xx; excluded from the fit) | 79      |
| dns.mx.null                           | 20      |
| dns.mx.none                           | 59      |

Both models were fitted the same way: logistic regression, with a small
penalty (L2, 1, none on the intercept) that keeps the
coefficients modest.

## Examples

Real domains from the set-aside 20%, one of each kind, with what each
model gave them and what happened when they were probed:

| Kind                        | Domain           | MX                                        | SPF | dns-reachability | dns-only | Probe    |
| --------------------------- | ---------------- | ----------------------------------------- | --- | ---------------- | -------- | -------- |
| Google Workspace            | 360realtors.com  | aspmx.l.google.com +4                     | yes | 99.1%            | 90.2%    | accepted |
| Microsoft 365               | 1105cms01.com    | 1105cms01-com.mail.protection.outlook.com | yes | 99.1%            | 81.4%    | accepted |
| Registrar forwarding        | 1xoc.com         | eforward1.registrar-servers.com +4        | yes | 99.1%            | 90.2%    | accepted |
| Self-hosted, one MX, SPF    | 24-7-network.com | mail.24-7-network.com                     | yes | 74.5%            | 81.4%    | accepted |
| Self-hosted, one MX, no SPF | 247myserver.com  | mx.stackmail.com                          | no  | 61.5%            | 69.8%    | accepted |
| Self-hosted, several MX     | 1000predicas.com | mx1-hosting.jellyfish.systems +2          | yes | 74.5%            | 90.2%    | accepted |
| No MX, A records only       | 0nline.tv        | (none)                                    | no  | 2.1%             | 2.1%     | timeout  |

## dns-reachability

The coefficients are in log-odds. For each feature a domain has, its
number is added to the intercept, and the sum becomes the probability.
Positive numbers push the score up, negative ones down.

| Term          | Log-odds  |
| ------------- | --------- |
| intercept     | -3.50735  |
| hasMx         | 4.31163   |
| hasA          | -0.141008 |
| hasAaaa       | -0.195878 |
| hasSpf        | 0.606265  |
| knownProvider | 3.66963   |

How it did on the set-aside domains: AUC 0.939 — the
chance that a random accepting domain outscores a random non-accepting
one. Log loss 0.2556 and Brier score 0.0830
measure how far the probabilities were from what happened; smaller is
better.

Say you treat every domain at or above a threshold as "accepts mail".
"Flagged" is how many of the set-aside domains score that high,
"precision" how many of those really accepted, and "recall" how many of
all the accepting domains are caught. The "below" columns read the other
way: domains under the threshold treated as "doesn't accept".

| Threshold | Flagged | Precision | Recall | Below: precision | Below: recall |
| --------- | ------- | --------- | ------ | ---------------- | ------------- |
| 0.5       | 70.2%   | 83.7%     | 99.4%  | 98.9%            | 72.0%         |
| 0.6       | 70.2%   | 83.7%     | 99.4%  | 98.9%            | 72.0%         |
| 0.7       | 65.5%   | 86.1%     | 95.5%  | 92.3%            | 77.7%         |
| 0.8       | 32.9%   | 98.6%     | 55.0%  | 60.4%            | 98.9%         |
| 0.85      | 31.1%   | 100.0%    | 52.7%  | 59.5%            | 100.0%        |
| 0.9       | 31.1%   | 100.0%    | 52.7%  | 59.5%            | 100.0%        |
| 0.95      | 31.1%   | 100.0%    | 52.7%  | 59.5%            | 100.0%        |

A calibrated model's scores match what happens: of the domains scored
around 0.9, about 90% should accept. Each row groups the set-aside
domains by their score:

| Predicted | Domains | Mean predicted | Accepted |
| --------- | ------- | -------------- | -------- |
| 0.0–0.1   | 268     | 2.2%           | 1.1%     |
| 0.6–0.7   | 42      | 61.8%          | 50.0%    |
| 0.7–0.8   | 293     | 74.6%          | 73.4%    |
| 0.8–0.9   | 16      | 80.4%          | 75.0%    |
| 0.9–1.0   | 280     | 99.1%          | 100.0%   |

## dns-only

The coefficients are in log-odds. For each feature a domain has, its
number is added to the intercept, and the sum becomes the probability.
Positive numbers push the score up, negative ones down.

| Term       | Log-odds  |
| ---------- | --------- |
| intercept  | -3.7078   |
| hasMx      | 4.66821   |
| hasA       | -0.232622 |
| hasAaaa    | 0.11184   |
| hasSpf     | 0.634     |
| multipleMx | 0.749704  |

How it did on the set-aside domains: AUC 0.884 — the
chance that a random accepting domain outscores a random non-accepting
one. Log loss 0.3235 and Brier score 0.0964
measure how far the probabilities were from what happened; smaller is
better.

Say you treat every domain at or above a threshold as "accepts mail".
"Flagged" is how many of the set-aside domains score that high,
"precision" how many of those really accepted, and "recall" how many of
all the accepting domains are caught. The "below" columns read the other
way: domains under the threshold treated as "doesn't accept".

| Threshold | Flagged | Precision | Recall | Below: precision | Below: recall |
| --------- | ------- | --------- | ------ | ---------------- | ------------- |
| 0.5       | 70.2%   | 83.7%     | 99.4%  | 98.9%            | 72.0%         |
| 0.6       | 70.2%   | 83.7%     | 99.4%  | 98.9%            | 72.0%         |
| 0.7       | 67.1%   | 85.2%     | 96.8%  | 94.3%            | 75.8%         |
| 0.8       | 66.7%   | 85.5%     | 96.6%  | 94.0%            | 76.4%         |
| 0.85      | 30.0%   | 88.1%     | 44.8%  | 53.4%            | 91.3%         |
| 0.9       | 29.6%   | 88.0%     | 44.1%  | 53.1%            | 91.3%         |
| 0.95      | 0.0%    | —         | 0.0%   | 40.9%            | 100.0%        |

A calibrated model's scores match what happens: of the domains scored
around 0.9, about 90% should accept. Each row groups the set-aside
domains by their score:

| Predicted | Domains | Mean predicted | Accepted |
| --------- | ------- | -------------- | -------- |
| 0.0–0.1   | 268     | 2.3%           | 1.1%     |
| 0.6–0.7   | 28      | 69.8%          | 50.0%    |
| 0.7–0.8   | 3       | 74.7%          | 33.3%    |
| 0.8–0.9   | 334     | 81.7%          | 83.5%    |
| 0.9–1.0   | 266     | 90.3%          | 88.0%    |
