# Fabel

A Dixit-style storytelling card game, synced live over Supabase.

## 1. Create the database (5 min)

1. Go to [supabase.com](https://supabase.com), sign up free, **New project**. Pick any name/region, save the database password somewhere.
2. Once it's ready: **SQL Editor → New query**, paste in everything from `schema.sql` in this folder, click **Run**.
3. **Project Settings → API** (technically "Data API" in newer Supabase UIs). Copy the **Project URL** and the **anon public** key — you'll need both next. These are safe to put in client-side code; the SQL you just ran (`Row Level Security`) is what actually controls access.

## 2. Run it locally first (optional but recommended)

```
npm install
cp .env.example .env
# paste your Project URL and anon key into .env
npm run dev
```

Open the local link, create a room, and confirm it works before publishing anything.

## 3. Put it on GitHub Pages

1. Create a new **public** GitHub repo, push this folder to it.
2. **Repo → Settings → Pages → Build and deployment → Source: GitHub Actions.** (The workflow in `.github/workflows/deploy.yml` is already set up to build and deploy automatically.)
3. **Repo → Settings → Secrets and variables → Actions → New repository secret.** Add two:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   (same two values from step 1.3 — the workflow needs them at build time since they're not committed to the repo)
4. Push to `main`. Check the **Actions** tab for the run; once it's green, your site is live at `https://<username>.github.io/<repo>/`.

Any further push to `main` redeploys automatically.

## 4. Adding the real card deck

Once you've generated and culled images (see `deck-kit.md` from earlier), drop them in a `/cards` folder in this same repo, named `card-01.jpg` … `card-84.jpg`. They'll be served at:

```
https://<username>.github.io/<repo>/cards/card-01.jpg
```

Paste that full list of URLs (one per line) into the "card images" box on the home screen when creating a room.

## Notes

- **Trust model:** anyone who knows the 4-letter room code can read and write that room's data (see the comment in `schema.sql`). That matches the earlier prototype — fine for a private family game shared over WhatsApp, not a substitute for real per-player authentication.
- **Free tier:** Supabase pauses a project after 7 days with no activity — it comes back automatically the next time someone opens the app, just with a few seconds' delay on that first load. GitHub Pages has no such pause.
- Game rules and scoring live in `src/App.jsx`, in the same handful of functions as before (`startGame`, `tally`, `nextRound`, `applyAction`) — tell me what to change and I'll edit them directly.
