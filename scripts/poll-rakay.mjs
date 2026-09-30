#!/usr/bin/env node
/**
 * Poll the PRIVATE rakay repo and dispatch its own CI — and its releases —
 * here, on rakay-ci.
 *
 * WHY THIS EXISTS
 * ──────────────
 * The private repo cannot run ANY Actions job — it is out of minutes, so even a
 * two-second dispatcher fails with `steps: []` and `runner_id: 0`. The same
 * thing was verified on the kraft pair, so it is a property of the account, not
 * of a particular workflow.
 *
 * A consequence worth spelling out: `on: push: tags:` in the private repo would
 * NEVER fire. A tag cannot trigger anything by itself. The event has to be
 * observed from the free side, which is what this script does, every tick.
 *
 * TWO THINGS ARE POLLED
 * ─────────────────────
 * · commits — `main` and every open pull request. Untested SHAs get a
 *   `rakay-ci` dispatch, which is ci.yml: lint, typecheck, test, build, then a
 *   commit status posted back on the private repo.
 *
 * · tags — names matching RAKAY_TAG_PATTERN (default `^v`). A tag is published
 *   only once CI is green on the commit it points at, so a tag on an untested
 *   or broken commit asks for the test instead of shipping the images. The
 *   green ones get a `rakay-release` dispatch, which is docker-images.yml:
 *   build the two images and push them to the private GHCR namespace.
 *
 * DESIGN
 * ──────
 * One writer (this script) to one state file, so there is no race. Dedup is by
 * SHA for commits and by tag → SHA for tags: a commit is tested once, a tag is
 * published once, and moving a tag onto another commit is the only thing that
 * publishes it again. A run that never reports is retried after STALE_MS.
 *
 * Failures are deliberately NOT recorded for tags. A red `rakay-ci` on the
 * commit a tag points at simply means "not published yet": the next tick says
 * so again, and the moment CI goes green — a re-run by hand is enough — the
 * release goes out on its own. Recording it would have frozen that tag forever.
 *
 * The state file is the only thing this workflow ever commits back. Nothing here
 * writes to rakay — ci.yml's `report` job owns that side.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const RAKAY_REPO = "rakay-technology/rakay";
const STATE_PATH = resolve(process.cwd(), ".ci-state/state.json");
const STATE_CONTEXT = "rakay-ci"; // the context ci.yml's `report` job posts

/** Re-dispatch a run that has been "pending" longer than this. */
const STALE_MS = 25 * 60 * 1000;
/** Drop history beyond this, so the file cannot grow without bound. */
const MAX_HISTORY = 200;
/** Which tags are worth an image build. Overridable from the workflow. */
const TAG_PATTERN = new RegExp(process.env.RAKAY_TAG_PATTERN || "^v");

const token = process.env.GH_TOKEN;
if (!token) throw new Error("GH_TOKEN is required");

const api = async (path) => {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`${path} → HTTP ${res.status} ${await res.text()}`);
  }
  return res.json();
};

/** Fire a repository_dispatch on THIS repo. GITHUB_TOKEN first (contents:write
 *  is enough), falling back to the rakay PAT if this org restricts it. */
const dispatchEvent = async (eventType, payload) => {
  const senders = [
    [process.env.GITHUB_TOKEN, "GITHUB_TOKEN"],
    [token, "RAKAY_PAT"],
  ].filter(([tok]) => Boolean(tok));

  for (const [tok, label] of senders) {
    const res = await fetch(
      `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/dispatches`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${tok}`,
          accept: "application/vnd.github+json",
        },
        body: JSON.stringify({ event_type: eventType, client_payload: payload }),
      },
    );
    if (res.ok) return;
    const why = await res.text();
    console.log(`  dispatch ${eventType} with ${label} → ${res.status} ${why}`);
  }
  throw new Error(`could not dispatch ${eventType} on ${process.env.GITHUB_REPOSITORY}`);
};

// ─── state ────────────────────────────────────────────────────────────────
const loadState = () => {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { version: 2, runs: {}, tags: {} };
  }
};
const state = loadState();
state.version = 2; // 1 → 2 added `tags`, when releases started being polled
state.runs ??= {};
state.tags ??= {}; // a state file written before releases were polled

// ─── helpers ──────────────────────────────────────────────────────────────
/** The rakay-ci status already posted on a commit, or null. */
const readStatus = async (sha) => {
  try {
    const statuses = await api(`/repos/${RAKAY_REPO}/commits/${sha}/status`);
    return statuses.statuses.find((s) => s.context === STATE_CONTEXT) ?? null;
  } catch {
    return null;
  }
};

/**
 * Make sure CI has run, or is running, for a commit.
 * Returns { state, action } where state is the settled result or "pending",
 * and action is "settled" (read back or already known), "inflight" (a run
 * exists) or "dispatched" (this tick started one).
 */
const ensureCi = async (sha, ref, kind) => {
  const known = state.runs[sha];

  // Already settled — this exact commit has been reported. Never re-test the
  // same SHA, pass or fail: only a NEW commit earns a new run.
  if (known && known.state !== "pending") {
    return { state: known.state, action: "settled" };
  }

  // `known.at` is an ISO STRING. Subtracting it from a number yields NaN, and
  // `NaN < STALE_MS` is false — so this guard would be dead code and every tick
  // would re-dispatch commits that are still running. Parse it.
  const dispatchedAt = known?.at ? new Date(known.at).getTime() : 0;
  if (known && Date.now() - dispatchedAt < STALE_MS) {
    return { state: "pending", action: "inflight" };
  }

  // Either never seen, or the previous run went quiet. Ask rakay what it has.
  const reported = await readStatus(sha);
  if (reported && reported.state !== "pending") {
    state.runs[sha] = {
      ref,
      kind,
      state: reported.state,
      desc: reported.description ?? "",
      at: new Date().toISOString(),
    };
    return { state: reported.state, action: "settled" };
  }

  // A run exists but has not concluded: leave it alone and retry on a later
  // tick rather than starting a second one for the same commit.
  if (reported?.target_url) {
    return { state: "pending", action: "inflight" };
  }

  await dispatchEvent("rakay-ci", { sha });
  state.runs[sha] = { ref, kind, state: "pending", at: new Date().toISOString() };
  return { state: "pending", action: "dispatched" };
};

// ─── 1. what does rakay want tested? ──────────────────────────────────────
const targets = [];

const branch = process.env.RAKAY_BRANCH || "main";
try {
  const { sha } = await api(`/repos/${RAKAY_REPO}/commits/${branch}`);
  targets.push({ sha, ref: `refs/heads/${branch}`, kind: "branch" });
} catch (err) {
  console.log(`branch ${branch}: ${err.message}`);
}

try {
  const pulls = await api(`/repos/${RAKAY_REPO}/pulls?state=open&per_page=50`);
  for (const pr of pulls) {
    targets.push({
      sha: pr.head.sha,
      ref: pr.head.ref,
      kind: `pr#${pr.number}`,
    });
  }
} catch (err) {
  console.log(`pulls: ${err.message}`);
}

// ─── 2. commits and pull requests ─────────────────────────────────────────
let dispatched = 0;

if (targets.length > 0) {
  console.log(`polling ${targets.length} commit target(s) on ${RAKAY_REPO}`);
}

for (const t of targets) {
  const { state: result, action } = await ensureCi(t.sha, t.ref, t.kind);
  console.log(`  ${t.sha.slice(0, 8)} (${t.kind}) → ${action === "dispatched" ? "dispatched" : result}`);
  if (action === "dispatched") dispatched += 1;
}

// ─── 3. tags worth releasing ──────────────────────────────────────────────
let tags = [];
try {
  tags = await api(`/repos/${RAKAY_REPO}/tags?per_page=100`);
} catch (err) {
  console.log(`tags: ${err.message}`);
}

const candidates = tags.filter((t) => TAG_PATTERN.test(t.name));
if (candidates.length > 0) {
  console.log(`checking ${candidates.length} tag(s) against ${TAG_PATTERN}`);
}

let released = 0;

for (const tag of candidates) {
  const sha = tag.commit.sha;
  const known = state.tags[tag.name];

  // Published for this exact commit already. A tag that MOVES onto another
  // commit is the one case that publishes it again.
  if (known && known.sha === sha) continue;

  const ci = await ensureCi(sha, `refs/tags/${tag.name}`, `tag:${tag.name}`);

  if (ci.state !== "success") {
    // Not recorded on purpose: the tag is simply not ready. The tick after CI
    // turns green — even from a manual re-run — publishes it.
    console.log(
      `  ${tag.name} (${sha.slice(0, 8)}) → ci ${ci.state}, not publishing`,
    );
    continue;
  }

  await dispatchEvent("rakay-release", { tag: tag.name });
  state.tags[tag.name] = { sha, state: "released", at: new Date().toISOString() };
  released += 1;
  console.log(`  ${tag.name} (${sha.slice(0, 8)}) → release dispatched`);
}

// ─── 4. prune + persist ───────────────────────────────────────────────────
const prune = (map) =>
  Object.fromEntries(
    Object.entries(map)
      .sort(([, a], [, b]) => String(b.at).localeCompare(String(a.at)))
      .slice(0, MAX_HISTORY),
  );

state.runs = prune(state.runs);
state.tags = prune(state.tags);

if (dispatched > 0 || released > 0 || JSON.stringify(loadState()) !== JSON.stringify(state)) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
  console.log(
    `state written (${Object.keys(state.runs).length} commits, ` +
      `${Object.keys(state.tags).length} tags, ${dispatched} dispatched, ${released} released)`,
  );
} else {
  console.log("state unchanged");
}
