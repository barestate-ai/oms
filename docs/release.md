# Release checklist

## How a release happens

Everyday work goes through pull requests into `master`. `main` is the release branch: it only takes merges from `master`, and a merge to `main` releases.

1. Set `releaseVersion` in the root `package.json` (currently **0.1.3**) and add a `## <version>` section to `CHANGELOG.md`. That field is the only place the version lives, and the workspaces stay at 0.0.1. The release is refused if the changelog section is missing or empty.
2. Open a pull request from `master` into `main`. CI runs on it.
3. Merge it. `.github/workflows/release.yml` runs on the push to `main` (never from `master`, forks or other branches): it typechecks, tests and packs the archive, then waits for the owner to approve the `npm` environment.
4. After approval it publishes the exact archive it tested with `npm publish --provenance` through npm trusted publishing (no npm token is stored), checks that the registry's tarball has the same SHA-256, creates the `v<version>` tag and GitHub Release with the tarball, its checksum and the changelog section as notes, and smoke-tests the npm package and `curl -fsSL https://barestate.xyz/oms/install | sh`.
5. Bump the Homebrew formula (see Publication). The run summary lists the URL and SHA-256.

A run for a version that is already on npm and already released does nothing, so a rerun or a merge that does not change the version is harmless. A run where npm has the version but the GitHub Release is missing only creates the release.

### One-time setup (owner)

- Create `master` from `main`, make it the default branch, and protect both branches (CI and the merge queue run on both).
- Create an `npm` environment in the repository settings with the owner as required reviewer.
- On npmjs.com, add a trusted publisher for `@barestate/oms`: repository `barestate-ai/oms`, workflow `release.yml`, environment `npm`.

## Prepare the archive by hand

The workflow does this for you; the steps below are for a local check.

- Confirm `releaseVersion` in the root `package.json` (currently **0.1.3**). The root `package.json` and the private workspaces stay at 0.0.1; the generated public archive carries the release version.
- Run `npm ci --ignore-scripts`, `npm run typecheck` and `npm test`. Keep missing-infrastructure results (no Surfpool, no Docker) distinct from passes. No model call is needed for these checks.
- Run `npm run pack:release`. It stages the `cli`, `engine`, `core`, `contract`, `surfnet`, `sandbox` and `review` packages; `packages/signer` and `bench/` stay in the repository and are not shipped. It stages only runtime source, the launcher, documentation, licenses, the runtime manifest and startup art. TypeScript is compiled to JavaScript because Node cannot strip TypeScript from installed `node_modules`. Internal workspace imports resolve within the archive. External runtime dependencies are installed from npm under the root dependency overrides and bundled; their `scripts` sections are removed so installing the package cannot run third-party install code, and the `oms` entry file is made executable.

The script runs `npm pack --ignore-scripts --json` and rejects a compressed archive above **25,000,000 bytes**.

Output: `.tmp/release/barestate-oms-0.1.3.tgz`. The staging allowlist does not copy `.env`, `.keys`, `.oms` or local state. Keep provider configuration and credentials outside the archive.

## Clean-machine smoke test

Use an ordinary user account with Node >=22.19.0 and npm. Copy the archive to that machine. From a new empty directory:

```sh
npm init -y
npm install /absolute/path/to/barestate-oms-0.1.3.tgz --ignore-scripts --no-audit --no-fund
npx --no-install oms --help
npx --no-install oms doctor
```

Help should list `doctor`, `workspace`, `task` and `run`. Doctor should identify missing tools and return nonzero while required prerequisites are absent. It must not start an agent.

Install Surfpool 1.7.0 with `oms doctor --install`, which downloads the archive named in `node_modules/@barestate/oms/packages/engine/runtime-manifest.json` and checks its SHA-256. Then test both modes:

```sh
npx --no-install oms
npx --no-install oms --sandbox docker
```

In each TUI, check `/help`, `/connect`, `/model`, `/status`, `/quit` and `/art off`. Opening the UI should send no model request. Follow the [quickstart](quickstart.md) for provider-specific connection steps. Credentialed sign-in and paid responses are owner-operated acceptance checks.

On a prepared offline task, run `/verify` and confirm a pinned failure leaves the task open, then confirm the expected valid source passes on a fresh offline Surfpool chain.

## Publication

The workflow publishes and verifies the archive's checksum. Publishing by hand is only for an emergency: review the exact commit and the staged archive first, and verify the published archive's checksum against the local file.

After publishing, bump the npm tarball URL and SHA-256 in `Formula/oms.rb` in [barestate-ai/homebrew-tap](https://github.com/barestate-ai/homebrew-tap) for every release. Download the published tarball and calculate its checksum with `shasum -a 256` (or `sha256sum`), then run `brew style barestate-ai/tap/oms` and `brew audit --strict barestate-ai/tap/oms` from the tap. Smoke-test `curl -fsSL https://barestate.xyz/oms/install | sh` with `OMS_VERSION` set to the new version.
