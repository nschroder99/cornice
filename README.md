# Cornice

A phone app for learning NYC architecture vocabulary: daily spaced-repetition reviews plus a field journal of buildings you've seen. Static site, no server; progress and photos stay on the phone.

## Content
- `content/decks/*.json`: the terms, one file per deck. Each term has `def`, `spot` (how to recognize it), `ex` (real NYC examples), optional `confuse` (ids of look-alike terms) and `q` (Commons search used to find its photo).
- `content/images/`, `content/credits.json`: one Wikimedia Commons photo per term and its credit.

After editing decks or photos:

```
npm run check      # rebuilds content/index.json + precache.json, then validates every term
```

Adding photos for new terms:

```
node scripts/fetch-images.js candidates <id> ...   # search Commons, write contact sheets to .images-work/sheets
# put choices in .images-work/picks.json: { "<id>": <0-5 or "File:...">, ... }
node scripts/fetch-images.js download
```

## Running
`npm run serve`, then open http://localhost:8090. Hosted on GitHub Pages; install on iPhone via Share → Add to Home Screen (needed so Safari doesn't clear stored data).

Back up from Settings → Back up to Files; the file holds progress and journal photos.
