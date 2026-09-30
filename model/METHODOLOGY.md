# How the score models are built

`scoreDns` answers: given only a domain's DNS records — public
information anyone can look up in milliseconds — how likely is it that a
mail server for that domain answers when you knock? We can't know
without knocking. But we can measure the connection between DNS facts
and knocking outcomes on thousands of domains, and turn the measurement
into a formula.

This page explains the whole method and the math behind it, assuming no
statistics background. The worked numbers are from the 1.0.0 fit; the
current figures are always in this directory's `report-<version>.md`.

## 1. A sample nobody picked

We start from the [Tranco list](https://tranco-list.eu/), a published
ranking of the million most-visited domains, and take a random sample of
5,000. Random matters: hand-picked domains could accidentally be ones
that make the model look good.

The "random" is a trick worth knowing. Each domain name goes through a
**hash function** (SHA-256), which works like a blender: feed in
`example.com`, get out a huge number with no visible pattern — but the
same name always gives the same number. Sorting the million domains by
their hash shuffles them thoroughly, yet anyone rerunning the script
gets the identical shuffle. Random, but repeatable; nobody can quietly
re-roll the dice.

## 2. The facts and the truth

For each domain, `scripts/corpus.ts` collects two things.

**The facts (the features).** Its DNS records:

- `hasMx` — MX records exist (signposts saying "mail for us goes here").
- `hasA`, `hasAaaa` — the domain has a server address (IPv4 / IPv6).
- `hasSpf` — an SPF record exists (a published mail policy).
- `knownProvider` — the MX belongs to a provider the classifier's
  registry knows (Google Workspace, Microsoft 365, …), the same match
  `detectProviderByMx` makes.
- `multipleMx` — there is more than one MX host.

**The truth (the label).** We connect to the domain's mail server on
port 25, say `EHLO` (SMTP's "hello"), and record whether it answered
properly — a `220` greeting, then `250` — before saying `QUIT`. We never
send mail and never ask about any mailbox.

Truth-gathering has traps, and the collector handles them:

- Our own connection sometimes got throttled. Dead air then doesn't mean
  the domain is dead, so the script keeps re-probing domains that
  already accepted as controls, and throws away everything collected
  while the controls fail.
- 79 domains only ever answered "try again later" (a 4xx reply, usually
  greylisting). That proves nothing either way, so they're excluded.
- A DNS lookup that fails isn't recorded at all; a rerun tries it again.

The 1.0.0 corpus: 5,000 domains sampled, 4,937 recorded (63 lookups
kept failing), 4,549 probed, 79 excluded as greylisted — leaving 4,470
domains, each a row of 0s and 1s plus a yes/no answer. 2,765 accepted.

## 3. Hiding the exam

The domains are split **80/20**. The models learn only from the 80%
(3,571 domains). The other 20% (899) are locked away and used purely for
grading. Why? The same reason an exam has problems you haven't seen:
anyone can ace the exact questions they studied. Every number in the
report comes from the hidden 20%. The same hash trick decides who is
hidden, so the split never shifts between refits.

## 4. The formula

The models are **logistic regression**, which is two ideas glued
together.

**Idea 1: a points system.** Give each feature a weight and add up the
points. For the default model, `dns-reachability` 1.0.0:

```
s = −3.51 + 4.31·hasMx + 0.61·hasSpf + 3.67·knownProvider
    − 0.14·hasA − 0.20·hasAaaa
```

That is `y = mx + b` with several inputs. The −3.51 (the _intercept_) is
the starting score before any facts are counted.

**Idea 2: squash the score into a probability.** A sum like `s` can be
any number, but a probability must sit between 0 and 1. So the score
goes through the **logistic function**:

```
p = 1 / (1 + e^(−s))        (e ≈ 2.718)
```

When `s` is 0, `p` is 0.5 — a coin flip. Big positive `s` pushes `p`
toward 1, big negative toward 0:

| s   | −4   | −2   | 0    | 2    | 4    |
| --- | ---- | ---- | ---- | ---- | ---- |
| p   | 0.02 | 0.12 | 0.50 | 0.88 | 0.98 |

The weights have a clean meaning through **odds** (probability for vs.
against, as in "3 to 1"). Adding `w` to the score multiplies the odds by
`e^w`. So `hasMx`'s +4.31 multiplies the odds by e<sup>4.31</sup> ≈ 75,
and `knownProvider`'s +3.67 by ≈ 39. The small negative weights
(× 0.87, × 0.82) barely nudge. A weight is what the feature says _after_
all the other features have spoken, which is why `hasA` can be slightly
negative here even though real domains usually have websites: among
probed domains without MX records — parked websites, mostly — nothing
answers on port 25, and a website address is exactly what they do have.

Worked examples, real domains from the hidden 20%:

- A Gmail-hosted domain, every feature on:
  `s = −3.51 + 4.31 − 0.14 − 0.20 + 0.61 + 3.67 = 4.74`, so
  `p = 1/(1+e^−4.74) ≈ 0.99`. It accepted.
- A self-hosted domain, one MX, SPF: `s = 1.07`, so `p ≈ 0.75`. It
  accepted.
- A parked website, no MX: `s = −3.85`, so `p ≈ 0.02`. It timed out.

## 5. Finding the weights

Nobody chose 4.31 by hand. First define what "good weights" means: for
each training domain, the formula assigns a probability to what actually
happened — `p` if the domain accepted, `1 − p` if it didn't. Multiply
those 3,571 numbers together and you get the probability the model
assigned to reality. The best weights make that as large as possible
("maximum likelihood").

Two practical wrinkles:

- Multiplying thousands of numbers below 1 gives an absurdly tiny
  result, so the script works with logarithms, which turn multiplication
  into addition without changing which weights win. That's where "log
  loss" comes from.
- A small penalty on big weights (**L2 regularization**, λ = 1) makes
  the model pay a tax proportional to each weight squared. That stops
  wild, confident swings that merely memorize quirks of the training
  set — a built-in "prefer the modest explanation". The intercept is
  untaxed: it only sets the base rate and claims nothing about any
  feature.

Then the computer searches: start with every weight at zero, ask "which
small change to each weight makes my predictions fit the training
answers better?", step that way, and repeat. This particular problem is
bowl-shaped — one lowest point, no false valleys to get stuck in — so
the search (Newton's method, a sharper cousin of guess-and-improve)
lands on the single best answer in a handful of steps, and lands on the
same answer every time.

## 6. Grading

All of it on the hidden 899 domains, none of which the models saw.
Figures here are `dns-reachability` 1.0.0; the report has both models.

- **Log loss 0.256.** On average the model assigned
  e<sup>−0.256</sup> ≈ 77% probability to what actually happened. A
  know-nothing model always guessing the base rate scores ≈ 0.68.
- **Brier score 0.083.** The average of (prediction − outcome)², with
  outcome as 1 or 0 — a squared error. Smaller is better.
- **AUC 0.939.** Take one random accepting domain and one random
  refusing one; 93.9% of the time the model scores the accepter higher.
  A coin flip manages 50%.
- **Calibration.** The promise behind the word "probability": of the
  domains scored 0.9–1.0, did about that share accept? (In 1.0.0: 280
  domains there, 100% accepted; in the 0.0–0.1 bucket, 1.1%.)
- **Precision and recall.** For picking a cutoff. Trust everything
  scoring ≥ 0.9 and, in 1.0.0, _precision_ is 100% (of the domains you
  trusted, all really accepted) while _recall_ is 52.7% (of all the
  accepting domains, the share you caught). Lower the bar and you catch
  more but trust more mistakes; the report's table lists the trade at
  each threshold.

## 7. The fine print

The labels come from one vantage point — a phone tethered on Google Fi —
on one day, on port 25 only. Mail servers often distrust mobile and home
addresses, so some refusals may say more about the vantage point than
the domain; acceptances can't be faked that way. And "accepts a
connection" is not "will deliver your email". The formula is exactly as
good as these measurements, and no better.

## Rerunning everything

From the repo root, by hand — never in CI, because probing connects to
other people's mail servers:

```sh
npm run corpus -- --list-id <Tranco list ID>   # collect (resumable)
npm run fit -- --version <semver>              # fit, grade, write the report
```

The corpus itself is `corpus.jsonl` in this directory; `scripts/fit.ts`
regenerates `../src/model.ts` and the report from it, deterministically.
