// OpenTable availability checker (headed Chrome + user cookies).
//
// WHY headed Chrome: OpenTable is behind Akamai, which resets the TLS connection for every
// non-browser client (curl, headless Chrome, server-side fetchers). The only reliable path is a
// REAL visible Chrome window carrying the user's opentable.com cookies. A Chrome window will flash
// open when this runs — that is expected, do not treat it as an error.
//
// Strategy: open one restaurant page to establish a trusted session and capture the app's own
// RestaurantsAvailability GraphQL request, then replay that request in-page (same-origin, so cookies
// + Akamai pass) for each target restaurant / anchor time.
//
// Usage:
//   OT_COOKIE_FILE=/path/to/cookies.txt OT_DAY=2026-07-20 OT_PARTY=4 OT_START=18:00 OT_END=20:00 \
//     node opentable.js '[{"name":"Zaytinya","slug":"zaytinya-new-york"}]'
//
// Each target needs an OpenTable slug (path segment in opentable.com/r/<slug>) OR an "rid"
// (numeric restaurantId). Slug alone is fine — the rid is auto-discovered from the page.
// Cookie file = the raw "Cookie:" header string copied from a logged-in opentable.com request
// (contains session-bound anti-bot tokens _abck / bm_* that expire — re-paste when calls start 401ing).

const path = require('path');
const fs = require('fs');

// Resolve playwright from the persistent cache dir this skill installs into (see setup_opentable.sh).
const CACHE = path.join(process.env.HOME, '.cache', 'reservation-checker', 'node_modules');
let chromium;
try {
  ({ chromium } = require(path.join(CACHE, 'playwright')));
} catch (e) {
  console.error('Playwright not found. Run scripts/setup_opentable.sh first.');
  process.exit(2);
}

const COOKIE_FILE = process.env.OT_COOKIE_FILE;
const DAY = process.env.OT_DAY || '2026-07-20';
const PARTY = Number(process.env.OT_PARTY || 2);
const START = process.env.OT_START || '00:00';
const END = process.env.OT_END || '23:59';
const TZ = process.env.OT_TZ || 'America/New_York';
const TIMES = ['18:00', '19:00', '20:00'];  // query anchors; slots return as offsets around each
const toMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const T_MIN = toMin(START), T_MAX = toMin(END);

if (!COOKIE_FILE || !fs.existsSync(COOKIE_FILE)) {
  console.error('Set OT_COOKIE_FILE to a readable cookie file (raw Cookie header from logged-in opentable.com).');
  process.exit(2);
}

function parseCookies(str) {
  return str.trim().split(/;\s*/).map(pair => {
    const i = pair.indexOf('=');
    if (i < 1) return null;
    return { name: pair.slice(0, i), value: pair.slice(i + 1), domain: '.opentable.com', path: '/' };
  }).filter(Boolean);
}

(async () => {
  const targets = JSON.parse(process.argv[2] || '[]');
  if (!targets.length) { console.error('Pass targets JSON: [{"name","slug"|"rid"}]'); process.exit(2); }

  const browser = await chromium.launch({ headless: false, channel: 'chrome' });
  const context = await browser.newContext({ timezoneId: TZ, locale: 'en-US' });
  await context.addCookies(parseCookies(fs.readFileSync(COOKIE_FILE, 'utf8')));
  const page = await context.newPage();

  let availReq = null;
  page.on('request', r => {
    if (r.url().includes('opname=RestaurantsAvailability') && !availReq)
      availReq = { url: r.url(), method: r.method(), postData: r.postData(), headers: r.headers() };
  });

  const results = [];
  for (const t of targets) {
    let rid = t.rid || null;
    availReq = null;
    const slug = t.slug || rid;
    const url = `https://www.opentable.com/r/${slug}?dateTime=${DAY}T19%3A00&covers=${PARTY}`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) { results.push({ name: t.name, error: 'nav: ' + e.message.slice(0, 60) }); continue; }
    await page.waitForTimeout(6000);
    if (!availReq) {
      for (const sel of ['button:has-text("Find a time")', 'button:has-text("Find a table")',
                         '[data-test="find-table-button"]', 'button[type="submit"]']) {
        const btn = page.locator(sel).first();
        if (await btn.count() && await btn.isVisible().catch(() => false)) { await btn.click().catch(() => {}); break; }
      }
    }
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !availReq) await page.waitForTimeout(500);
    if (!rid) {
      rid = await page.evaluate(() => {
        const ids = [...document.documentElement.outerHTML.matchAll(/"restaurantId"\s*:\s*(\d+)/g)]
          .map(m => Number(m[1])).filter(n => n > 0);
        return ids.length ? ids.sort((a, b) => ids.filter(x => x === b).length - ids.filter(x => x === a).length)[0] : null;
      }).catch(() => null);
    }
    const reqVars = (() => {
      if (!availReq) return null;
      try {
        if (availReq.postData) return JSON.parse(availReq.postData).variables;
        return JSON.parse(new URL(availReq.url).searchParams.get('variables'));
      } catch (e) { return null; }
    })();
    if (!rid && reqVars) rid = (reqVars.restaurantIds && reqVars.restaurantIds[0]) || reqVars.restaurantId || null;
    if (!availReq || !reqVars || !rid) {
      results.push({ name: t.name, rid, error: 'no availability request captured' }); continue;
    }

    const slotSet = new Map();
    for (const anchor of TIMES) {
      const vars = JSON.parse(JSON.stringify(reqVars));
      if (vars.restaurantIds) vars.restaurantIds = [rid];
      if ('restaurantId' in vars) vars.restaurantId = rid;
      if ('date' in vars) vars.date = DAY;
      if ('dateTime' in vars) vars.dateTime = `${DAY}T${anchor}`;
      if ('time' in vars) vars.time = anchor;
      if ('partySize' in vars) vars.partySize = PARTY;
      if ('covers' in vars) vars.covers = PARTY;
      const replayHeaders = {};
      for (const [k, v] of Object.entries(availReq.headers || {})) {
        if (/^(:|cookie|host|content-length|accept-encoding)/i.test(k)) continue;
        replayHeaders[k] = v;
      }
      let body;
      if (availReq.postData) {
        const pd = JSON.parse(availReq.postData); pd.variables = vars;
        body = await page.evaluate(async ({ href, payload, hdrs }) => {
          const r = await fetch(href, { method: 'POST', headers: hdrs, body: JSON.stringify(payload) });
          return { status: r.status, text: await r.text() };
        }, { href: availReq.url, payload: pd, hdrs: replayHeaders }).catch(e => ({ status: -1, text: String(e) }));
      } else {
        const u = new URL(availReq.url);
        u.searchParams.set('variables', JSON.stringify(vars));
        body = await page.evaluate(async ({ href, hdrs }) => {
          const r = await fetch(href, { headers: hdrs });
          return { status: r.status, text: await r.text() };
        }, { href: u.toString(), hdrs: replayHeaders }).catch(e => ({ status: -1, text: String(e) }));
      }
      if (body.status !== 200) { slotSet.set('__err' + anchor, body.status + ' ' + body.text.slice(0, 80)); continue; }
      let j; try { j = JSON.parse(body.text); } catch (e) { continue; }
      const [ah, am] = anchor.split(':').map(Number);
      for (const av of (j.data && j.data.availability) || []) {
        for (const day of av.availabilityDays || []) {
          if (day.dayOffset !== 0) continue;
          for (const s of day.slots || []) {
            if (!s.isAvailable) continue;
            slotSet.set(ah * 60 + am + s.timeOffsetMinutes, true);
          }
        }
      }
    }
    const errs = [...slotSet.keys()].filter(k => String(k).startsWith('__err'));
    const mins = [...slotSet.keys()].filter(k => typeof k === 'number').sort((a, b) => a - b);
    const fmt = m => { const h = Math.floor(m / 60), mm = String(m % 60).padStart(2, '0'); const ap = h >= 12 ? 'PM' : 'AM'; return `${h > 12 ? h - 12 : h}:${mm} ${ap}`; };
    results.push({
      name: t.name, rid,
      window: mins.filter(m => m >= T_MIN && m <= T_MAX).map(fmt),
      allFound: mins.map(fmt),
      errors: errs.map(k => slotSet.get(k)),
    });
  }
  await browser.close();
  console.log(JSON.stringify(results, null, 1));
})();
