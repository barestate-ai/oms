# Blend

Blend is OMS's hosted multi-model router. Select a profile instead of choosing
one underlying model for every coding request. The profile decides which model
handles a request and may make additional routing or retry calls. You keep using
the same OMS conversation and tools.

Profiles were selected from a pre-registered Solana Bench tournament (November
2025). Blend does not guarantee that it will be cheaper or more accurate than a
single model; results below are from a fixed benchmark environment.

## Sign in and select Blend

Blend requires a **signed-in, invited OMS account**. Inside OMS, run `/login` and
complete the sign-in flow, then select a profile:

```text
/blend
/blend auto
/blend pro
/blend flash
/blend off
```

`/blend` selects Auto. The named commands switch profiles. `/blend off` returns
to the model you used before entering Blend in this live session. If no previous
model is saved, use `/model` to select one.

You can also open `/model` and select an entry in the **Blend** group. An OMS
account sign-in is separate from provider connections in `/connect`; signing in
to a model subscription alone does not grant Blend access. You do not need to
give OMS your own provider API keys to use hosted Blend.

## Profiles

Auto, Pro and Flash are available by command and in the model picker. Scores
are Solana Bench headline numbers from one run per config in the same batch
(50 submissions, 30-minute wall clock, pinned Surfpool 0.10.4); single-run
scores carry meaningful run-to-run variance.

<!-- profiles -->

| Profile | Command | Policy | Bench score / cost per run |
| --- | --- | --- | --- |
| Auto (default) | `/blend auto` | Ember works; escalates to Fable on real tool failures or after 20 turns | 266 / $3.84 |
| Pro | `/blend pro` | Same as Auto; best measured score | 266 / $3.84 |
| Flash | `/blend flash` | Fable leads the first turns, then hands routine work to Ember; Fable returns on real failures | 230 / $2.81 |

References from the same batches: Opus alone scored 231 at $2.84, and an
escalation config that never actually used the cheap model (now fixed) scored
258–318 at $5.3–6.9 — effectively Fable alone at lower measured cost than
first estimated.

## Usage and privacy

The hosted router records cost and operational metadata: a hashed user
identifier, profile and model, token counts, status and elapsed time. It does
**not** log prompt or response text, tool arguments, account tokens or provider
keys. Your request content is still sent to the model providers needed to answer
it; their data policies apply. This is not a promise of zero provider retention.
OMS's normal local conversation history is separate from router telemetry.

OMS uses the router's settled cost receipt for its usage display and spend
accounting. That cost can include multiple model calls, routing and retries.
Failed attempts may use conservative input estimates when a provider omits
usage; assessed costs are not vendor invoices. A missing or invalid receipt
stops the request rather than assuming it was free. Normal OMS session caps
still apply in addition to hosted limits.

## Limits and errors

Hosted access has per-minute, concurrent-request and daily-dollar limits. A
request may be refused even when your local OMS session has budget remaining.

| Status | Meaning and next step |
| --- | --- |
| 401 / 403 | Sign-in is missing, expired or not permitted. Use `/login`; an invited account is required. |
| 429 | A rate or concurrency limit was reached, or an upstream provider is usage-limited. Wait before retrying. |
| 402 | A hosted dollar limit or admission budget was reached. Wait for the applicable daily reset or use another connected model; raising a local cap does not raise hosted limits. |
| 503 | Blend is temporarily unavailable. Try later or select another connected model. |

Responses may arrive after a delay while usage and cost are collected; streaming
compatibility does not guarantee immediate token-by-token output.

## Held-out results

<!-- heldout -->

Held-out accuracy, paired comparisons and cost results are pending. No Blend
winner or savings claim is published here yet.
