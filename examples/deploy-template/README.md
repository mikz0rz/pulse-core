# Deploy template

A minimal, copy-paste starter for running your own deployment of
[pulse-core](../../README.md). Nothing here is specific to any deployment —
copy this folder into a **new repo of your own**, fill in `.env` and
`sources.json`, and run.

## Quick start

```bash
# 1. Copy this folder out into its own repo, then:
#    edit package.json → set "pulse-core": "github:<your-user>/pulse-core#main"
npm install

# 2. Configure
cp .env.example .env        # fill in secrets
#    edit sources.json      # enable/point the sources you want

# 3. Run
npm run build
npm start                   # http://localhost:3000  (log in with APP_PASSWORD)
```

## What's here

| File | Yours to edit |
|---|---|
| `src/main.ts` | thin entry — reads env, loads sources, calls `startTerminal()` |
| `sources.json` | which sources to track (one example of each type; enable what you want) |
| `.env.example` | the secrets/config to copy into `.env` |
| `Dockerfile` | container build for a VPS |

## Docker

```bash
docker build -t my-terminal .
docker run --env-file .env -p 3000:3000 my-terminal
```

Put a reverse proxy (Caddy/Nginx) in front to terminate TLS — a password is
sent on login, so don't expose plain HTTP publicly.

## Going further

See the repo's [DEPLOYMENT.md](../../DEPLOYMENT.md) for the advanced patterns:
running **multiple site variants** from one deploy repo (e.g. a basic vs.
extended site), keeping **private "secret sauce"** (custom prompts/ranking)
out of the public engine via extension points, and pinning the core to a
version tag.
