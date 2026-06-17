# Deploying Puppy Poker

Goal: get a public URL your friends anywhere can open. Two steps:
**(1) push to GitHub**, then **(2) deploy to a host that supports WebSockets.**

Poker is real-time, so the host MUST support WebSockets. Render, Railway, and
Fly.io all do. Plain "static site" hosts (GitHub Pages, Netlify) will NOT work
because there's no Python server there.

---

## Step 1 - Publish to GitHub

You don't have the `gh` CLI, so create the repo on the website first:

1. Go to https://github.com/new
2. Repository name: `puppy-poker` (or whatever). Leave it **empty** -- do NOT
   add a README/.gitignore (you already have them).
3. Click **Create repository**. Copy the repo URL it shows, e.g.
   `https://github.com/YOURNAME/puppy-poker.git`

Then from the project folder:

```bash
cd ~/Projects/poker
git remote add origin https://github.com/YOURNAME/puppy-poker.git
git push -u origin main
```

If GitHub asks for a password, it actually wants a **Personal Access Token**
(Settings -> Developer settings -> Personal access tokens -> Fine-grained,
give it "Contents: Read/Write" on this repo). Paste the token as the password.

Done -- your code is on GitHub.

---

## Step 2 - Deploy on Render (free, easiest)

This repo already includes `render.yaml`, so Render auto-configures itself.

1. Go to https://render.com and sign in with GitHub.
2. **New +** -> **Blueprint**.
3. Pick your `puppy-poker` repo. Render reads `render.yaml` and shows a
   `puppy-poker` web service on the **free** plan.
4. Click **Apply** / **Create**. It installs deps and starts the server.
5. After a minute you get a public URL like
   `https://puppy-poker.onrender.com`. Open it, create a table, share the
   `/t/...` link with friends. That's it -- no VPN, no LAN needed.

### Free-tier gotchas (totally fine for casual play)
- **It sleeps after ~15 min idle.** The first visit after a nap takes ~30s to
  wake up. Just wait and refresh.
- **State is in memory.** If Render restarts/redeploys the app, open tables and
  ledgers are wiped. Fine for a session; not a permanent record. (Ask me to add
  SQLite persistence if you want tables to survive restarts.)
- Free instances are single-process -- perfect, because the game state lives in
  one process anyway.

---

## Alternative hosts (same idea)

**Railway** (https://railway.app): New Project -> Deploy from GitHub repo ->
pick repo. It detects the `Procfile`. Generate a domain under Settings -> Networking.

**Fly.io** (https://fly.io, needs the `flyctl` CLI and Docker-style build):
```bash
fly launch          # detects the Dockerfile, creates the app
fly deploy
```
Fly keeps the app always-on (no sleep) on small free-ish allowances.

---

## Updating after you change code

Every push to GitHub auto-redeploys (Render/Railway with autoDeploy on):
```bash
git add -A
git commit -m "tweak whatever"
git push
```

## Test it locally exactly like production
```bash
PORT=8021 uvicorn main:app --host 0.0.0.0 --port 8021
```
