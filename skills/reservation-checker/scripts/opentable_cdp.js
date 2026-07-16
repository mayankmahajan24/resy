// OpenTable availability checker — CDP ride-along variant.
//
// WHY: Injecting copied cookies into a fresh Playwright Chrome fails because Akamai ties the
// _abck token to the ORIGINAL browser's fingerprint + sensor data. A Playwright browser has a
// different fingerprint and trips automation signals (navigator.webdriver / CDP), so Akamai
// challenges it and the app never loads availability. Fix: don't copy cookies — ATTACH to the
// user's real Chrome (which already passed Akamai) over the DevTools protocol and drive it.
//
// SETUP (user runs this once, in a terminal):
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//     --remote-debugging-port=9222 --user-data-dir=/tmp/ot-chrome-profile
//   ...then in that Chrome window, log in to opentable.com. Leave it open.
//
// RUN:
//   OT_DAY=2026-07-20 OT_PARTY=4 OT_START=18:00 OT_END=20:00 OT_TZ=America/New_York \
//     node opentable_cdp.js '[{"name":"Nami Nori","slug":"nami-nori-west-village-new-york"}]'
//
// Strategy: for each venue, open the /r/<slug> page with the target date+party in the URL,
// let the REAL session render, then SCRAPE the visible time-slot buttons (no fragile GraphQL
// capture). Queries 6/7/8 PM anchors and unions the results to cover the window.

const path = require('path');
const CACHE = path.join(process.env.HOME, '.cache', 'reservation-checker', 'node_modules');
let chromium;
try { ({ chromium } = require(path.join(CACHE, 'playwright'))); }
catch (e) { console.error('Playwright not found. Run scripts/setup_opentable.sh first.'); process.exit(2); }

const CDP = process.env.OT_CDP || 'http://localhost:9222';
const DAY = process.env.OT_DAY || '2026-07-20';
const PARTY = Number(process.env.OT_PARTY || 2);
const START = process.env.OT_START || '00:00';
const END = process.env.OT_END || '23:59';
const ANCHORS = ['18:00', '19:00', '20:00'];
const toMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const T_MIN = toMin(START), T_MAX = toMin(END);

// Parse an OpenTable-style time label ("6:15 PM") to minutes-since-midnight, else null.
function labelToMin(txt) {
  const m = txt.match(/\b(\d{1,2}):(\d{2})\s*(AM|PM)\b/i);
  if (!m) return null;
  let h = Number(m[1]) % 12; if (/pm/i.test(m[3])) h += 12;
  return h * 60 + Number(m[2]);
}

(async () => {
  const targets = JSON.parse(process.argv[2] || '[]');
  if (!targets.length) { console.error('Pass targets JSON: [{"name","slug"}]'); process.exit(2); }

  let browser;
  try { browser = await chromium.connectOverCDP(CDP); }
  catch (e) {
    console.error('Could not attach to Chrome at ' + CDP + '.\nLaunch Chrome with:\n' +
      '  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir=/tmp/ot-chrome-profile\n' +
      'then log in to opentable.com and rerun.');
    process.exit(3);
  }
  const context = browser.contexts()[0];
  const page = context.pages()[0] || await context.newPage();

  const results = [];
  for (const t of targets) {
    const slug = t.slug || t.rid;
    const found = new Set();
    let blocked = false, navErr = null;
    for (const anchor of ANCHORS) {
      const url = `https://www.opentable.com/r/${slug}?dateTime=${DAY}T${anchor}&covers=${PARTY}`;
      try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); }
      catch (e) { navErr = e.message.slice(0, 60); continue; }
      // Detect an Akamai challenge/denial page.
      const title = (await page.title().catch(() => '')) || '';
      if (/access denied|pardon our interruption|are you a robot/i.test(title)) { blocked = true; break; }
      await page.waitForTimeout(3500);
      // Scrape any button/anchor that looks like a bookable time slot.
      const labels = await page.evaluate(() => {
        const out = [];
        const els = document.querySelectorAll(
          '[data-test*="time" i] a, [data-test*="time" i] button, ' +
          'a[href*="/booking/"], [data-test="times-panel"] *, ' +
          'button, a[role="button"]');
        els.forEach(el => { const tx = (el.innerText || el.textContent || '').trim(); if (tx) out.push(tx); });
        return out;
      }).catch(() => []);
      for (const tx of labels) { const m = labelToMin(tx); if (m != null) found.add(m); }
    }
    if (blocked) { results.push({ name: t.name, error: 'akamai challenge (session not trusted)' }); continue; }
    const mins = [...found].sort((a, b) => a - b);
    const fmt = m => { const h = Math.floor(m / 60), mm = String(m % 60).padStart(2, '0'); const ap = h >= 12 ? 'PM' : 'AM'; return `${((h + 11) % 12) + 1}:${mm} ${ap}`; };
    results.push({
      name: t.name,
      window: mins.filter(m => m >= T_MIN && m <= T_MAX).map(fmt),
      allFound: mins.map(fmt),
      ...(navErr && !mins.length ? { note: 'nav issues: ' + navErr } : {}),
    });
  }
  // Do NOT close — it's the user's own browser.
  await browser.close().catch(() => {});
  console.log(JSON.stringify(results, null, 1));
})();
