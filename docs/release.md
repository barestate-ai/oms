# Release checklist

## Prepare the archive

- Confirm the release version in `scripts/pack-release.mjs` (currently **0.1.3**). The root `package.json` and the private workspaces stay at 0.0.1; the generated public archive carries the release version.
- Run `npm ci --ignore-scripts`, `npm run typecheck` and `npm test`. Keep missing-infrastructure results (no Surfpool, no Docker) distinct from passes. No model call is needed for these checks.
- Run `npm run pack:release`. It stages the `cli`, `engine`, `core`, `contract`, `surfnet`, `sandbox` and `review` packages; `packages/signer` and `bench/` stay in the repository and are not shipped. It stages only runtime source, the launcher, documentation, licenses, the runtime manifest and startup art. TypeScript is compiled to JavaScript because Node cannot strip TypeScript from installed `node_modules`. Internal workspace imports resolve within the archive. External runtime dependencies are installed from npm under the root dependency overrides and bundled; their `scripts` sections are removed so installing the package cannot run third-party install code, and the `oms` entry file is made executable.

The script runs `npm pack --ignore-scripts --json` and rejects a compressed archive above **25,000,000 bytes**.

Output: `.tmp/release/barestate-oms-0.1.3.tgz`. The staging allowlist does not copy `.env`, `.keys`, `.oms` or local state. Keep provider configuration and credentials outside the archive.

## Clean-machine smoke test

Use an ordinary user account with Node >=22.19.0 and npm. Copy the archive to that machine. From a new empty directory:

```sh
npm init -y
npm install /absolute/path/to/barestate-oms-0.1.3.tgz --ignore-scripts --no-audit --no-fund
npx --no-install oms --version
npx --no-install oms --help
npx --no-install oms doctor
```

Version should be `0.1.3`. Help should show `/blend` and the Auto, Pro and Flash choices; advanced help lists `workspace`, `task` and `run`. Doctor should identify missing tools and return nonzero while required prerequisites are absent. It must not start an agent.

Install Surfpool 1.7.0 with `oms doctor --install`, which downloads the archive named in `node_modules/@barestate/oms/packages/engine/runtime-manifest.json` and checks its SHA-256. Then test both modes:

```sh
npx --no-install oms
npx --no-install oms --sandbox docker
```

In each TUI, check `/help`, `/connect`, `/model`, `/status`, `/quit` and `/art off`. Opening the UI should send no model request. Follow the [quickstart](quickstart.md) for provider-specific connection steps. Credentialed sign-in and paid responses are owner-operated acceptance checks.

On a prepared offline task, run `/verify` and confirm a pinned failure leaves the task open, then confirm the expected valid source passes on a fresh offline Surfpool chain.

## Publication

Review the exact commit and the staged archive before publishing. Verify the published archive's checksum against the local file before announcing availability.
