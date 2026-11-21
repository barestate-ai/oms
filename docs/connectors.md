# Connectors

Connectors let the agent use the tools your team already uses: GitHub, GitLab, Linear, Slack, Docker, AWS and read-only Solana RPC lookups. They are off until you turn one on. Open the list with `/connectors`. (`/connect` is different: it signs in to a model provider.)

## The list

`/connectors` shows every connector with a mark and what the agent may do with it:

- `●` working, `◐` needs a sign-in, `○` off or not installed, `✕` not working.
- Space turns one on or off. `A` steps the access level. Enter signs in. `R` checks again. Esc goes back. The mouse works too: click a row to select it, click its mark to switch it.
- OMS never stores a token. GitHub and GitLab sign in through their own `gh` and `glab` tools, and those keep the login. Hosted connectors (Linear, Slack, GitLab hosted) sign in with your browser; OMS keeps only that sign-in, in a private file under `~/.oms/agent`.
- The saved choices are in `~/.oms/connectors.json`: on or off, and the access level. If the file is damaged, connectors are turned off and the list says so.

## Access levels

| Level | What the agent can do |
| --- | --- |
| read | Look: pull requests, issues, CI, containers, and a reviewed list of AWS describe/list/get calls. |
| ask | Also change things, one approval at a time. Each change appears in the approval row. |
| allow | Change things without asking (GitHub, GitLab, Linear and Slack only). YOLO does not turn this on. |

Every change is approved once, never for the whole session: a comment or a new issue goes to other people, a container starts a program as you, and approving one is not approving the next with other text. The approval row shows everything that goes out (the whole comment, the whole container command, every flag), and a call too long to show is refused. Docker and AWS never offer `allow`, whatever `connectors.json` says. AWS is read-only in this version.

Before `compose up` asks, OMS reads the compose file in your folder with `docker compose config` and shows the services, images, ports and mounts. A file that mounts folders outside your project — through service mounts, secrets, configs, named volumes or a build context — the Docker socket or host devices, or asks for privileged containers, the host's network or cgroup, powerful capabilities or another container's volumes, is refused. Docker runs with a short environment (no API keys), and a compose file that changes after you approve it is not started.

## Commands that use a connected service

- `/pr [number] [request]` has the agent review a pull request. `/issue <number|LIN-123> [request]` has it work on an issue. `/ci [request]` has it look at failing checks.
- OMS fetches the text with your own signed-in tool, labels it as outside data, and sends it to the agent with your request. The agent never sees your login.
- `/account <address> --cluster devnet|mainnet` and `/tx <signature> --cluster devnet|mainnet` look things up on a public network, read-only, when Solana RPC is on. Set `HELIUS_API_KEY` in your shell to use Helius.

## Safety

- Programs run on your machine with a fixed set of arguments; values you or the agent supply are checked first, and nothing goes through a shell.
- Text that comes back from a service is capped at 16 KB and framed so the agent treats it as data, not instructions.
- Secret-looking values are masked on screen, and in what AWS and the hosted connectors send back to the agent.
- AWS runs only operations OMS has reviewed. Operations that can return a secret (a function's environment variables, a task definition, a cluster token, an instance's user data) are refused, or answer with a fixed list of safe fields.
