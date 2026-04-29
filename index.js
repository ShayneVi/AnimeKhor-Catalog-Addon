// index.js — AnimeKhor Stremio Addon
// Reads catalog.json (built by scraper.js) and serves correct IMDB IDs
// so all your streaming addons (FlixStreams, AIOStreams etc) find streams.

const express = require('express');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 7000;

// ---------------------------------------------------------------------------
// Load catalog.json
// ---------------------------------------------------------------------------
let CATALOG = { shows: [] };

function loadCatalog() {
  try {
    const p = path.join(__dirname, 'catalog.json');
    if (fs.existsSync(p)) {
      CATALOG = JSON.parse(fs.readFileSync(p, 'utf8'));
      console.log(`Loaded catalog: ${CATALOG.totalShows} shows, ${CATALOG.totalEpisodes} episodes`);
    } else {
      console.warn('catalog.json not found — run scraper.js first!');
    }
  } catch (e) {
    console.error('Failed to load catalog.json:', e.message);
  }
}

loadCatalog();

// ---------------------------------------------------------------------------
// Build lookup maps for fast access
// ---------------------------------------------------------------------------
function buildMaps() {
  const byImdb = new Map();  // imdbId → show
  const bySlug = new Map();  // seriesSlug → show

  for (const show of CATALOG.shows) {
    if (show.imdbId) byImdb.set(show.imdbId, show);
    for (const s of show.seasons || []) {
      bySlug.set(s.slug, show);
    }
  }

  return { byImdb, bySlug };
}

let { byImdb, bySlug } = buildMaps();

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  next();
});

// ---------------------------------------------------------------------------
// MANIFEST
// We serve catalog + meta only.
// Streams are handled by your existing addons (FlixStreams, AIOStreams)
// because we emit real IMDB IDs they already understand.
// ---------------------------------------------------------------------------
app.get('/manifest.json', (req, res) => {
  res.json({
    id: 'org.animekhor.catalog',
    version: '2.0.0',
    name: 'AnimeKhor Donghua',
    description: 'Full catalog of Chinese donghua from AnimeKhor.org with correct episode ordering. Streams via your existing addons.',
    logo: 'https://animekhor.org/wp-content/uploads/2021/11/AnimeKhor_darkmode.png',
    resources: ['catalog', 'meta'],
    types: ['series'],
    // We emit IMDB IDs so streaming addons handle streams automatically
    idPrefixes: ['tt', 'animekhor|'],
    catalogs: [
      {
        type: 'series',
        id: 'animekhor_all',
        name: 'AnimeKhor – All Donghua',
        extra: [
          { name: 'search', isRequired: false },
          { name: 'skip',   isRequired: false }
        ]
      },
      {
        type: 'series',
        id: 'animekhor_noimdb',
        name: 'AnimeKhor – No IMDB Match',
        extra: [
          { name: 'search', isRequired: false },
          { name: 'skip',   isRequired: false }
        ]
      }
    ],
    behaviorHints: { adult: false, p2p: false }
  });
});

// ---------------------------------------------------------------------------
// Helper — show → Stremio meta item
// ---------------------------------------------------------------------------
function showToMeta(show) {
  // Use IMDB ID if we have it, otherwise our custom ID
  const id = show.imdbId || `animekhor|${show.seasons[0]?.slug || show.showName}`;
  return {
    id,
    type:        'series',
    name:        show.showName,
    poster:      show.poster,
    posterShape: 'poster',
  };
}

// ---------------------------------------------------------------------------
// CATALOG
// ---------------------------------------------------------------------------
app.get('/catalog/:type/:id/:extra?.json', (req, res) => {
  const { id, extra } = req.params;
  let search = req.query.search || '';
  let skip   = parseInt(req.query.skip || '0');

  if (extra) {
    for (const p of extra.split('&')) {
      const [k, v] = p.split('=');
      if (k === 'search') search = decodeURIComponent(v || '');
      if (k === 'skip')   skip   = parseInt(v || '0');
    }
  }

  let shows = CATALOG.shows || [];

  if (id === 'animekhor_all') {
    // All shows that have an IMDB ID (streaming addons can find them)
    shows = shows.filter(s => s.imdbId);
  } else if (id === 'animekhor_noimdb') {
    // Shows without IMDB ID — still browsable, streams may not work
    shows = shows.filter(s => !s.imdbId);
  }

  if (search) {
    const q = search.toLowerCase();
    shows = shows.filter(s => s.showName.toLowerCase().includes(q));
  }

  const metas = shows.slice(skip, skip + 20).map(showToMeta);
  res.json({ metas });
});

// ---------------------------------------------------------------------------
// META
// Called when user clicks a show. We return the episode list with
// correct absolute episode numbers (S1E1, S1E2... sequential across all seasons)
// so FlixStreams/AIOStreams find the right episode.
// ---------------------------------------------------------------------------
app.get('/meta/:type/:id.json', (req, res) => {
  const rawId = req.params.id;

  // Find the show — by IMDB ID or our custom ID
  let show = null;
  if (rawId.startsWith('tt')) {
    show = byImdb.get(rawId);
  } else {
    const slug = rawId.replace(/^animekhor[|:]/, '');
    show = bySlug.get(slug);
  }

  if (!show) {
    console.log(`Meta not found for ID: ${rawId}`);
    return res.json({ meta: null });
  }

  const id = show.imdbId || rawId;

  // Build video list — one entry per absolute episode
  const videos = (show.episodes || []).map(ep => {
    let released = new Date(0).toISOString();
    if (ep.date) {
      const d = new Date(ep.date);
      if (!isNaN(d.getTime())) released = d.toISOString();
    }

    return {
      // ID format: imdbId:season:episode — this is what streaming addons expect
      id:       `${id}:1:${ep.absoluteEpNum}`,
      title:    `Ep ${ep.absoluteEpNum} — ${ep.seriesTitle}`,
      season:   1,
      episode:  ep.absoluteEpNum,
      released,
      overview: `${ep.seriesTitle} — Local episode ${ep.localEpNum}`,
    };
  });

  console.log(`Meta: "${show.showName}" (${id}) — ${videos.length} episodes`);

  res.json({
    meta: {
      id,
      type:        'series',
      name:        show.showName,
      poster:      show.poster,
      description: `${show.seasons.map(s => s.title).join(' → ')}`,
      videos,
      posterShape: 'poster',
    }
  });
});

// ---------------------------------------------------------------------------
// Health + reload
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.json({
    addon:         'AnimeKhor v2.0',
    install:       `${req.protocol}://${req.get('host')}/manifest.json`,
    catalogLoaded: (CATALOG.shows?.length || 0) > 0,
    totalShows:    CATALOG.totalShows    || 0,
    totalEpisodes: CATALOG.totalEpisodes || 0,
    generated:     CATALOG.generated    || null,
  });
});

// Reload catalog without restarting (after re-running scraper.js)
app.get('/reload', (req, res) => {
  loadCatalog();
  const maps = buildMaps();
  byImdb = maps.byImdb;
  bySlug = maps.bySlug;
  res.json({ status: 'reloaded', shows: CATALOG.totalShows, episodes: CATALOG.totalEpisodes });
});

// Debug: show grouping for a search term
app.get('/debug/search/:q', (req, res) => {
  const q = req.params.q.toLowerCase();
  const results = (CATALOG.shows || [])
    .filter(s => s.showName.toLowerCase().includes(q))
    .map(s => ({
      showName: s.showName,
      imdbId:   s.imdbId,
      tmdbId:   s.tmdbId,
      seasons:  s.seasons.map(x => x.title),
      episodes: s.episodes.length,
    }));
  res.json(results);
});

// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`AnimeKhor addon v2.0 on port ${PORT}`);
  console.log(`Install: http://localhost:${PORT}/manifest.json`);
});
