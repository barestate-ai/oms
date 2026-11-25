# Contributing to OMS

Thanks for helping. This page covers how to set up, test and send a change.

## Set up

You need Node.js 22.19 or newer and git.

```sh
git clone <this repository>
cd oms
npm ci --ignore-scripts
node packages/cli/src/bin.ts doctor --install   # downloads the pinned Surfpool and checks its SHA-256
npm start                                        # runs OMS from source
```

## Check your change

```sh
npm run typecheck
SURFPOOL_BINARY="$(ls -d ~/.oms/tools/surfpool-*/surfpool | head -1)" npm test
```

Some tests need Docker or Linux; they report themselves as skipped when those are missing. CI runs everything on every pull request.

To check the npm package itself:

```sh
npm run pack:release
```

## Rules for changes

- **Behaviour first, tests always.** A bug fix comes with a test that fails before it and passes after. Don't weaken an existing test to make a change pass.
- **The model-facing prompt is locked.** `packages/engine/test` pins the exact bytes of the system prompt and its parts. If you mean to change the prompt, say so in the pull request and explain what you measured; a prompt change without evidence won't be merged.
- **Never commit secrets.** No API keys, tokens, wallets or keypair files, not even test ones from a real cluster. Tests generate throwaway keys at run time.
- **Keep the safety boundaries.** OMS must never read the user's keys, and the model must never close its own task. Changes near the guards, the sandbox, the signer or the verifier get extra review.
- **Keep it small and direct.** Prefer deleting code to adding layers. Put logic in the package that owns the concept.

## Pull requests

- Open pull requests against `master`. `main` is the release branch: a release is a pull request from `master` into `main` (see [docs/release.md](docs/release.md)).
- One topic per pull request, with a short description of what changed and why.
- Make sure typecheck and tests pass.
- By contributing, you agree that your contribution is licensed under the project's MIT licence.

## Questions

Open a discussion or an issue. For security problems, follow [SECURITY.md](SECURITY.md) instead.
