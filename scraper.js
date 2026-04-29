#!/usr/bin/env node
// scraper.js — run locally to build catalog.json
// Usage: node scraper.js
// Output: catalog.json (commit this to your repo)

const fetch = require('node-fetch');
const cheerio = require('cheerio');
const fs = require('fs');

const BASE_URL = 'https://animekhor.org';
const TMDB_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJiMDFjNzUyNTE5ZDY4ODg1ZjE1ZWExZTY1OTc2NTgyNCIsIm5iZiI6MTc2MTU3NTE5Ny40MTYsInN1YiI6IjY4ZmY4MTFkYWE2YjViYmNmNjlmYjdjZiIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.VTFk-LblHijk6Rkg8aVNZ9yMuo8DiPTC5Ip1kxJWTFs';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Referer': BASE_URL,
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Extract the "core name" used for grouping related seasons
// "The Demon Hunter Season 3 [Cang Yuan Tu Season 3]" → "the demon hunter"
// "Prelude of The Demon Hunter: Dongning" → "demon hunter"
// "Martial Master (Wushen Zhuzai) Season 2" → "martial master wushen zhuzai"
// ---------------------------------------------------------------------------
function coreName(title) {
  return title
    .toLowerCase()
    // Remove bracketed alternates like [Cang Yuan Tu Season 3]
    .replace(/\[.*?\]/g, '')
    // Remove parenthesised alternates
    .replace(/\(.*?\)/g, '')
    // Remove season/part indicators
    .replace(/\b(season|part|cour|s)\s*\d+\b/gi, '')
    // Remove ordinal indicators
    .replace(/\b(1st|2nd|3rd|\d+th)\b/gi, '')
    // Remove common prefix words that vary
    .replace(/\b(prelude of|tale of|legend of|record of|rise of|return of|revenge of)\b/gi, '')
    // Remove subtitle separators
    .replace(/[:\-–]/g, ' ')
    // Remove non-alphanumeric
    .replace(/[^a-z0-9\s]/g, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

// Check if two titles belong to the same show
function sameShow(a, b) {
  const ca = coreName(a);
  const cb = coreName(b);
  if (ca === cb) return true;

  // Check if one contains the other (min 6 chars to avoid false matches)
  const shorter = ca.length < cb.length ? ca : cb;
  const longer  = ca.length < cb.length ? cb : ca;
  if (shorter.length >= 6 && longer.includes(shorter)) return true;

  // Word overlap — if 60%+ of words match
  const wa = new Set(ca.split(' ').filter(w => w.length > 3));
  const wb = new Set(cb.split(' ').filter(w => w.length > 3));
  if (wa.size === 0 || wb.size === 0) return false;
  let overlap = 0;
  for (const w of wa) { if (wb.has(w)) overlap++; }
  const ratio = overlap / Math.min(wa.size, wb.size);
  return ratio >= 0.6;
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------
async function fetchHTML(url) {
  const res = await fetch(url, { headers: HEADERS, timeout: 20000 });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// ---------------------------------------------------------------------------
// Scrape all series from A-Z
// ---------------------------------------------------------------------------
async function scrapeAllSeries() {
  const letters = ['0-9', ...Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ')];
  const all = [];
  const seen = new Set();

  for (const letter of letters) {
    let page = 1, hasNext = true;
    process.stdout.write(`Scraping letter ${letter}...`);

    while (hasNext && page <= 20) {
      try {
        const url  = page === 1
          ? `${BASE_URL}/a-z-lists/?show=${letter}`
          : `${BASE_URL}/a-z-lists/page/${page}/?show=${letter}`;
        const html = await fetchHTML(url);
        const $    = cheerio.load(html);
        let found  = 0;

        $('article.bs').each((_, el) => {
          const a     = $(el).find('a').first();
          const href  = a.attr('href') || '';
          if (!href || !href.includes('/anime/') || seen.has(href)) return;

          const title =
            $(el).find('.tt').first().text().trim() ||
            $(el).find('img').first().attr('title') || '';
          if (!title) return;

          const img    = $(el).find('img').first();
          const poster = img.attr('src') || img.attr('data-src') || img.attr('data-lazy-src') || '';
          const full   = href.startsWith('http') ? href : `${BASE_URL}${href}`;
          const slug   = full.replace(BASE_URL, '').replace(/^\/anime\//, '').replace(/\/$/, '');

          seen.add(href);
          all.push({ slug, title, poster, url: full });
          found++;
        });

        hasNext = $('a.next, a[rel="next"], .next.page-numbers').length > 0;
        page++;
        await sleep(400);
        if (found === 0) hasNext = false;
      } catch (e) {
        console.error(`\nError [${letter} p${page}]:`, e.message);
        hasNext = false;
      }
    }
    console.log(` done`);
  }

  return all;
}

// ---------------------------------------------------------------------------
// Scrape episodes for a single series
// ---------------------------------------------------------------------------
async function scrapeEpisodes(slug) {
  const url = `${BASE_URL}/anime/${slug}/`;
  try {
    const html = await fetchHTML(url);
    const $    = cheerio.load(html);
    const episodes = [];
    const seen     = new Set();

    $('div.eplister ul li').each((_, li) => {
      const a        = $(li).find('a').first();
      const href     = a.attr('href') || '';
      const numText  = $(li).find('.epl-num').first().text().trim();
      const epNum    = parseInt(numText, 10);
      const dateText = $(li).find('.epl-date').first().text().trim();

      if (!href || isNaN(epNum) || epNum <= 0 || seen.has(epNum)) return;
      seen.add(epNum);

      let date = null;
      if (dateText) {
        const d = new Date(dateText);
        if (!isNaN(d.getTime())) date = d.toISOString();
      }

      episodes.push({
        epNum,
        url: href.startsWith('http') ? href : `${BASE_URL}${href}`,
        date,
      });
    });

    episodes.sort((a, b) => a.epNum - b.epNum);
    return episodes;
  } catch (e) {
    console.error(`  Episode scrape failed for ${slug}:`, e.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// TMDB lookup — search by title, return best match imdbId
// ---------------------------------------------------------------------------
const tmdbCache = new Map();

async function lookupTMDB(title) {
  const core = coreName(title);
  if (tmdbCache.has(core)) return tmdbCache.get(core);

  // Try a few query variations
  const queries = [
    title.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').replace(/season\s*\d+/gi, '').trim(),
    coreName(title).replace(/\b\w/g, c => c.toUpperCase()),
    title.split(':')[0].trim(),
    title.split('[')[0].trim(),
  ];

  for (const q of queries) {
    if (!q || q.length < 3) continue;
    try {
      const res  = await fetch(
        `https://api.themoviedb.org/3/search/tv?query=${encodeURIComponent(q)}&page=1`,
        { headers: { Authorization: `Bearer ${TMDB_TOKEN}`, 'Content-Type': 'application/json' } }
      );
      const data = await res.json();
      if (!data.results || data.results.length === 0) continue;

      // Find best match — prefer animation/Chinese results
      const match = data.results.find(r =>
        r.origin_country?.includes('CN') ||
        r.original_language === 'zh' ||
        r.genre_ids?.includes(16)
      ) || data.results[0];

      // Get external IDs (IMDB)
      const extRes  = await fetch(
        `https://api.themoviedb.org/3/tv/${match.id}/external_ids`,
        { headers: { Authorization: `Bearer ${TMDB_TOKEN}` } }
      );
      const extData = await extRes.json();
      const imdbId  = extData.imdb_id || null;
      const result  = { tmdbId: match.id, imdbId, name: match.name };

      tmdbCache.set(core, result);
      await sleep(250); // be polite to TMDB API
      return result;
    } catch (e) {
      console.error(`  TMDB lookup failed for "${q}":`, e.message);
    }
  }

  tmdbCache.set(core, null);
  return null;
}

// ---------------------------------------------------------------------------
// Group series by show
// ---------------------------------------------------------------------------
function groupSeries(allSeries) {
  const groups = []; // [{ showName, series: [...] }]

  for (const s of allSeries) {
    let placed = false;
    for (const g of groups) {
      if (sameShow(g.showName, s.title)) {
        g.series.push(s);
        placed = true;
        break;
      }
    }
    if (!placed) {
      groups.push({ showName: s.title, series: [s] });
    }
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('=== AnimeKhor Catalog Scraper ===\n');

  // Step 1: Get all series
  console.log('Step 1: Scraping all series from A-Z...');
  const allSeries = await scrapeAllSeries();
  console.log(`Found ${allSeries.length} total series\n`);

  // Step 2: Group by show
  console.log('Step 2: Grouping related seasons...');
  const groups = groupSeries(allSeries);
  console.log(`Grouped into ${groups.length} unique shows\n`);

  // Step 3: For each group, scrape episodes and sort chronologically
  console.log('Step 3: Scraping episodes for each series...');
  const catalog = [];

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    process.stdout.write(`[${gi + 1}/${groups.length}] ${group.showName}... `);

    // Scrape episodes for each season in this group
    const allEpisodes = [];
    let posterUrl = '';

    for (const s of group.series) {
      if (!posterUrl && s.poster) posterUrl = s.poster;
      const eps = await scrapeEpisodes(s.slug);
      for (const ep of eps) {
        allEpisodes.push({
          ...ep,
          seriesTitle: s.title,
          seriesSlug: s.slug,
        });
      }
      await sleep(300);
    }

    if (allEpisodes.length === 0) {
      console.log('no episodes found, skipping');
      continue;
    }

    // Sort all episodes chronologically by date
    // Episodes without dates keep their relative order within their series
    allEpisodes.sort((a, b) => {
      if (a.date && b.date) return new Date(a.date) - new Date(b.date);
      if (a.date && !b.date) return -1;
      if (!a.date && b.date) return 1;
      // Same series — keep epNum order
      if (a.seriesSlug === b.seriesSlug) return a.epNum - b.epNum;
      return 0;
    });

    // Assign absolute episode numbers (1-based sequential)
    const episodes = allEpisodes.map((ep, i) => ({
      absoluteEpNum: i + 1,
      seriesTitle:   ep.seriesTitle,
      seriesSlug:    ep.seriesSlug,
      localEpNum:    ep.epNum,
      date:          ep.date,
      url:           ep.url,
    }));

    // Step 4: TMDB lookup
    const tmdb = await lookupTMDB(group.showName);
    const imdbId  = tmdb?.imdbId  || null;
    const tmdbId  = tmdb?.tmdbId  || null;

    console.log(`${episodes.length} eps | IMDB: ${imdbId || 'not found'}`);

    catalog.push({
      showName:   group.showName,
      imdbId,
      tmdbId,
      poster:     posterUrl,
      seasons:    group.series.map(s => ({ title: s.title, slug: s.slug, poster: s.poster })),
      episodes,
    });

    await sleep(200);
  }

  // Step 5: Write output
  const output = {
    generated: new Date().toISOString(),
    totalShows: catalog.length,
    totalEpisodes: catalog.reduce((s, c) => s + c.episodes.length, 0),
    shows: catalog,
  };

  fs.writeFileSync('catalog.json', JSON.stringify(output, null, 2));
  console.log(`\n✅ Done! catalog.json written.`);
  console.log(`   ${output.totalShows} shows, ${output.totalEpisodes} total episodes`);
  console.log(`\nShows WITHOUT IMDB ID (may need manual lookup):`);
  catalog.filter(s => !s.imdbId).forEach(s => console.log(`  - ${s.showName}`));
}

main().catch(console.error);
