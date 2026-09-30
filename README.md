# rakay-ci

The free half of the Rakay CI. Nothing here is the product: this repository
exists so that GitHub Actions can run on the **public** side, where minutes are
unlimited, against the **private** `rakay-technology/rakay`.

## Why this repo exists

The private repository is out of Actions minutes, and a repository without
minutes does not run a degraded job — it runs **no** job at all:

```
steps: []
runner_id: 0
```

Even a two-second dispatcher fails that way, so a "just trigger the real CI
elsewhere" workflow cannot live in the private repo either. The trigger has to
start here. That is what `poll.yml` does.

## What runs

| File | Role |
| ---- | ---- |
| `.github/workflows/poll.yml` | Every 5 minutes, asks `rakay` for new commits and dispatches `ci.yml` for the untested ones |
| `.github/workflows/ci.yml` | Checks the private repo out, installs with pnpm, then lint → typecheck → test → build, and posts the result back as a `rakay-ci` commit status |
| `.github/workflows/docker-images.yml` | On a tag, publishes `rakay-api` and `rakay-web` to `ghcr.io/rakay-technology` |
| `scripts/poll-rakay.mjs` | The poller itself |
| `.ci-state/state.json` | Which SHAs have been tested. The only file this repo's workflows commit |

No image, no release and no source ever lands in this public repository. The
images go to the `rakay-technology` GHCR namespace and carry an
`org.opencontainers.image.source` label pointing at the private repo, which is
what makes them show up under `rakay → Packages`.

## The one secret

`RAKAY_PAT` — a fine-grained personal access token, stored in this repository
(Settings → Secrets and variables → Actions). It needs:

| Scope | Repository | Why |
| ----- | ---------- | --- |
| Contents: read | `rakay-technology/rakay` | checking the private repo out |
| Statuses: write | `rakay-technology/rakay` | posting the `rakay-ci` status on the commit |
| Packages: write | `rakay-technology` (org) | pushing to the GHCR namespace |

Nothing else. It cannot read other repositories, and it cannot write to this
one.

## Running something by hand

```bash
ORG=rk-ci-7f3c9a2e-5b6d-4c8f-9a1e-2d4b

# test a branch, a tag or a single commit
gh workflow run ci.yml -R $ORG/rakay-ci -f ref=main
gh workflow run ci.yml -R $ORG/rakay-ci -f ref=$(git -C ../rakay rev-parse HEAD)

# publish images for a tag that already passed CI
gh workflow run "Docker images" -R $ORG/rakay-ci -f tag=v0.1.0

# force a poll instead of waiting for the next tick
gh workflow run poll.yml -R $ORG/rakay-ci
```

## Two things to know

- **A commit is tested once**, pass or fail, keyed by SHA in
  `.ci-state/state.json`. Re-running CI on the same commit on purpose means
  dispatching `ci.yml` by hand; the poller will not do it again.
- **Scheduled workflows are suspended after 60 days without repository
  activity.** The state file is committed on most ticks, which keeps this repo
  active, but if CI ever stops silently, check Actions → *Poll rakay* for the
  suspended banner before debugging anything else.
