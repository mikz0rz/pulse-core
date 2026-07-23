# Building a deployment

`pulse-core` is the engine — it doesn't run itself. To put it online you write
a small **deploy repo** that supplies your secrets, your sources, and your
config, then calls `startTerminal()`. This guide goes from the simplest case to
the advanced open-core pattern (public engine + private deployment).

The golden rule: **the core stays generic and secret-free; everything specific
to *your* deployment lives in *your* deploy repo.** Keep your deploy repo
private if it contains real keys, list IDs, or competitor URLs.

---

## 1. The simplest deployment (single site)

Copy [`examples/deploy-template/`](./examples/deploy-template) into a new repo.
It's a complete, runnable starter:

- point the `pulse-core` dependency at your GitHub fork/copy (`github:mikz0rz/pulse-core#main`)
- `cp .env.example .env` and fill in secrets
- edit `sources.json` for what you want to track
- `npm install && npm run build && npm start`

That's a full deployment. Most people never need more than this.

---

## 2. Multiple site variants from one repo

You may want several sites with different feature sets from one codebase — say
a **basic** site for a team and an **extended** site for yourself — differing
only by config, not forked code. Structure the deploy repo like this:

```
apps/basic/main.ts        thin entry: startTerminal(basicConfig + secrets)
apps/extended/main.ts     thin entry: startTerminal(extendedConfig + secrets + private extensions)
config/basic.ts           { branding, features } — no secrets
config/extended.ts        { branding, features }
sources/basic.sources.json
sources/extended.sources.json
```

Each `config/*.ts` just sets branding and which features are on:

```ts
// config/basic.ts
import type { FeatureFlags, Branding } from "pulse-core";
export const basicConfig: { branding: Branding; features: FeatureFlags } = {
  branding: { title: "Team News", theme: "light" },
  features: { websiteDiff: false, extraSections: false, aiDigest: true },
};
```

```ts
// config/extended.ts
export const extendedConfig = {
  branding: { title: "Pro Terminal", theme: "dark" },
  features: { websiteDiff: true, extraSections: true, aiDigest: true },
};
```

Each `apps/*/main.ts` composes its config with env secrets and its own sources
file, then calls `startTerminal()`. Feature flags do the gating — e.g. with
`websiteDiff: false`, any `website_diff` source in the config is simply skipped,
so the basic site can even share a source list and just have that capability
turned off. Run them on different ports (`PORT`) with separate `dbPath`s.

---

## 3. Keeping private "secret sauce" out of the public engine

Some things you may NOT want in the open-source core — tuned LLM prompts, a
proprietary ranking model, a private data source. The core exposes **extension
points** so these plug in from your (private) deploy repo without ever living in
the public repo:

```ts
// private/prompts.ts  — in YOUR deploy repo, never in the public core
import type { TerminalExtensions } from "pulse-core";
export const myExtensions: TerminalExtensions = {
  prompts: {
    buildDigestPrompt: ({ description, bulletDump }) => `...your tuned wording...`,
    // buildFeedItemsPrompt, buildSectionsPrompt, buildWebsiteDiffPrompt also overridable
  },
};
```

```ts
// apps/extended/main.ts
import { myExtensions } from "../../private/prompts.js";
startTerminal({ /* ...config, secrets, sources... */, extensions: myExtensions });
```

Anything you don't override falls back to the core's generic defaults, so the
public engine is fully functional on its own — the extension just replaces the
wording for your deployment. The basic variant simply omits `extensions`.

This is the open-core split: **publish the engine, keep the deploy private.**

---

## 4. Docker & VPS

The template ships a `Dockerfile`. For multiple variants, use one Dockerfile per
variant (same image, different `CMD`) and a `docker-compose.yml` mapping each to
a port. On the VPS:

```bash
git clone <your-private-deploy-repo> && cd <it>
cp .env.example .env      # fill real secrets
docker compose up --build -d
```

Notes:
- The Docker image resolves `pulse-core` from GitHub at install time, so the
  core must be pushed (public or private-with-access) and the dependency must
  point at `github:mikz0rz/pulse-core#<ref>` — not a local `file:` path.
- Put Caddy or Nginx in front for automatic HTTPS; the login password is sent
  over the connection.
- Set `NODE_ENV=production` so the session cookie gets its `Secure` flag.

---

## 5. Pinning the core version

While you're the only developer, depending on `#main` is fine. Once a
deployment must not break from experimental core changes, tag the core and pin
to it:

```bash
# in pulse-core
git tag v0.2.0 && git push --tags
```

```jsonc
// in your deploy repo's package.json
"pulse-core": "github:mikz0rz/pulse-core#v0.2.0"
```

`git pull` + rebuild pulls core changes into every deployment automatically when
on `#main`; on a tag, you upgrade deliberately by bumping the ref. No package
registry needed — the GitHub-direct dependency is intentional.
