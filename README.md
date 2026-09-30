# rakay-ci

**The code stays private. Only the compute is public.**

`rakay` is private because we do not want it public — that is the whole reason it
is private. Nothing about this repository changes that. It exists for one reason:
GitHub Actions minutes are billed per repository, the private repository has none
left, and a repository without minutes does not run a degraded job, it runs **no
job at all**:

```
steps: []
runner_id: 0
```

Even a two-second dispatcher fails that way, so "just trigger the real CI from
the private repo" is not an option. Actions are free and unlimited on **public**
repositories, so the job has to start here, where runners cost nothing — and
check the private repository out with a token.

Nothing of rakay is ever published, copied or parked here. The sections below say
exactly what is, and the `Privacy guard` workflow fails the build if that ever
stops being true.

## What is left here after a run

| Thing | Left behind? | Why |
| ----- | ------------ | --- |
| Code, `dist/`, `.next/`, `node_modules` | **No** | They exist on the runner, which is destroyed at the end of the job |
| Artifacts | **No** | No workflow uploads any, and the guard fails if one starts to — an artifact in a public repository is downloadable by anyone |
| Docker build cache | **No** | `type=gha` would store the layer *contents*, built from the private tree, in this public repository's cache. It is deliberately not used; the price is a slower image build |
| Run logs | **Yes, for 1 day** | Retention is lowered from the 90-day default to the minimum. This is the one thing the model cannot delete for you: a failing typecheck, lint or test prints the offending lines of source. Delete a run early with `gh api -X DELETE repos/<org>/rakay-ci/actions/runs/<id>` |
| Actions cache | **Yes**, keyed by the lockfile hash | Only the pnpm store: public npm tarballs, no file from rakay |
| `.ci-state/state.json` | **Yes**, committed | The SHAs already tested. Useless without access to the private repository |
| Secrets | Never printed | GitHub redacts secret values in logs |

## What runs

| File | Role |
| ---- | ---- |
| `.github/workflows/poll.yml` | Every 5 minutes, asks `rakay` for new commits **and new tags**, then dispatches the two workflows below |
| `.github/workflows/ci.yml` | Checks the private repo out, installs with pnpm, then lint → typecheck → test → build, and posts the result back as a `rakay-ci` commit status |
| `.github/workflows/docker-images.yml` | Builds and publishes `rakay-api` and `rakay-web` to the private `ghcr.io/rakay-technology` namespace, once CI is green on the tag |
| `.github/workflows/privacy.yml` | Fails if any of the guarantees above is broken |
| `scripts/poll-rakay.mjs` | The poller itself |

The images go to the `rakay-technology` GHCR namespace and carry an
`org.opencontainers.image.source` label pointing at the private repo, which is
what makes them show up under `rakay → Packages`.

## Releasing

```bash
git tag v0.1.0 && git push origin v0.1.0     # on rakay — that's the whole gesture
```

Within five minutes the poller sees the tag and walks through:

1. **Is the commit green?** It reads the `rakay-ci` status on the commit the tag
   points at. No status, or still running → it asks for the test first and
   publishes nothing this tick.
2. **Red?** Nothing is published, and nothing is recorded — a tag that failed is
   retried on the next tick, so re-running CI by hand is enough to unblock it.
   This is deliberate: recording the failure would freeze that tag forever.
3. **Green?** It fires `rakay-release`, which is `docker-images.yml`: the gate
   re-checks the status, then `rakay-api` and `rakay-web` are built in parallel
   and pushed, tagged with the release tag plus `latest` (unless the tag contains
   a hyphen, so a `-rc1` never moves `latest`).

A tag that is **moved** onto another commit is rebuilt; a tag that already
produced images for its commit is not published twice.

`on: push: tags:` in `rakay` cannot do any of this: the private repo has no
Actions minutes, so none of its own jobs ever start — a tag push there is silent.
The event has to be observed from this side.

Only tags matching `RAKAY_TAG_PATTERN` (default `^v`) are considered, so a
throwaway tag does not trigger a build:

```bash
gh variable set RAKAY_TAG_PATTERN --body '^v' -R <this-org>/rakay-ci
```

To publish a tag right now instead of waiting for the tick:

```bash
gh workflow run "Docker images" -R $ORG/rakay-ci -f tag=v0.1.0
```

## The one secret

`RAKAY_PAT` — a fine-grained personal access token, stored in this repository
(Settings → Secrets and variables → Actions).

```bash
gh secret set RAKAY_PAT -R rk-ci-7f3c9a2e-5b6d-4c8f-9a1e-2d4b/rakay-ci
```

| Scope | Repository | Why |
| ----- | ---------- | --- |
| Contents: read | `rakay-technology/rakay` | checking the private repo out |
| Statuses: write | `rakay-technology/rakay` | posting the `rakay-ci` status on the commit |
| Packages: write | `rakay-technology` (org) | pushing to the GHCR namespace |

Nothing else. It cannot read your other repositories, and it cannot write to this
one. It is never left in the workspace: the checkout runs with
`persist-credentials: false`, so a third-party package running a lifecycle script
during `pnpm install` has no token to find.

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
  dispatching `ci.yml` by hand; the poller will not do it again. Tags are the
  one thing that is retried, on purpose — see *Releasing* above.
- **Scheduled workflows are suspended after 60 days without repository
  activity.** The state file is committed on most ticks, which keeps this repo
  active, but if CI ever stops silently, check Actions → *Poll rakay* for the
  suspended banner before debugging anything else.
