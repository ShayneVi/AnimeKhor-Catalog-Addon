# AnimeKhor Stremio Catalog Addon

A Stremio addon that scrapes **AnimeKhor.org** and provides a proper catalog of all donghua (Chinese anime), with **each season listed as a separate entry** — so Stremio requests the right episode from the right series.

## Why this exists

Cinemeta/TMDB lumps all Demon Hunter episodes into "Season 1", but AnimeKhor has them split as separate series (Season 2, Season 3, Chang Yuan Tu, etc.). This addon talks to AnimeKhor directly, so Stremio always asks for the right thing.

## Catalogs provided

- **AnimeKhor – Ongoing**: Currently airing donghua
- **AnimeKhor – All Donghua**: Full A-Z library (scraped and cached)

Both support search.

## Deploy to Render (free)

1. Push this folder to a GitHub repo
2. Go to [render.com](https://render.com) → New → **Web Service**
3. Connect your GitHub repo
4. Settings:
   - **Environment**: Node
   - **Build command**: `npm install`
   - **Start command**: `npm start`
   - **Plan**: Free
5. Deploy — Render gives you a URL like `https://your-addon.onrender.com`

## Install in Stremio

Once deployed, open Stremio and go to:
```
https://your-addon.onrender.com/manifest.json
```
Or paste the URL into **Stremio → Addons → Add addon**.

## How it works

1. **Catalog**: Scrapes AnimeKhor's A-Z list to find all series. Each AnimeKhor entry (e.g. "The Demon Hunter Season 3") becomes its own Stremio catalog item with its own ID.
2. **Meta**: When you click a show, it scrapes the AnimeKhor series page to get the episode list.
3. **Stream**: Returns the AnimeKhor episode page URL. The **existing AnimeKhor Stremio addon** then handles video extraction from that page — so you still need both addons installed.

## Works best with

Install this addon **alongside** the existing AnimeKhor streaming addon. This addon fixes the catalog/metadata, the other addon provides the actual video streams.

## Local development

```bash
npm install
npm start
# Open http://localhost:7000
```
