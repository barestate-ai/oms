# Blend

Blend is OMS's hosted multi-model router. Select a profile instead of choosing
one underlying model for every coding request. The profile decides which model
handles a request and may make additional routing or retry calls. You keep using
the same OMS conversation and tools.

Profiles were selected using two rounds of Solana Bench screening. Blend does
not guarantee that it will be cheaper or more accurate than a single model.

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
are means from Solana Bench basic runs with the same web and knowledge setup
(up to 50 submissions and 30 minutes, Surfpool 0.10.4). These small samples
show the trade-off, not a reliable prediction of future runs.

<!-- profiles -->

| Profile | Command | Policy | Mean score / mean cost (runs) |
| --- | --- | --- | --- |
| Auto (default) | `/blend auto` | Fable opens; MiMo Flash works between Fable reviews | 149 / $3.70 (2) |
| Pro | `/blend pro` | Fable handles every turn | 292 / $7.08 (1) |
| Flash | `/blend flash` | Fable opens; GLM Flash works between Fable reviews | 91.5 / $2.10 (2) |

Auto and Flash use six Fable opening turns, return to Fable after two
consecutive real tool failures or eight worker turns, and use Fable for the
final proposal. The Ember → Fable control scored 252 at $7.07 in the same
round as standalone Fable: lower score for essentially the same cost.

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
