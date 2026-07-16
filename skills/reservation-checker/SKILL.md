---
name: reservation-checker
description: >-
  Check restaurant reservation availability across Resy, OpenTable, SevenRooms, and DoorDash
  Reservations for a given date, party size, and time window. Use when the user gives one or more
  restaurants — by name, or as URL(s) that list/name restaurants (Eater/Resy blog maps, "best of"
  lists, a booking page) — and wants to know which have open tables. Optional constraints: date,
  time range, number of guests. Handles name→venue matching per platform, reports exact open slots,
  and flags any restaurant not bookable on any platform as a coverage gap to investigate.
---

# Reservation availability checker

Checks whether restaurants have bookable tables on **Resy**, **OpenTable**, **SevenRooms**, and
**DoorDash Reservations**. Scripts live in `scripts/` and are parametrized — nothing is hardcoded
except public API keys.

**DoorDash Reservations is 100% powered by SevenRooms** — a restaurant bookable "on DoorDash" is
the same SevenRooms venue underneath (DoorDash is only a discovery front-end). So the SevenRooms
checker *is* the DoorDash checker; there is no separate DoorDash API. That means the whole
reservation market is effectively **three** availability backends: Resy, OpenTable, SevenRooms
(= DoorDash). Between them, coverage of restaurants that take reservations should be **near 100%**.

## Inputs to gather

1. **Restaurants** — a mix of any of:
   - explicit names ("Babbo", "Penny"),
   - URL(s) that contain/list restaurant names (e.g. an Eater heatmap, a Resy blog list, a
     "best new restaurants" article). Fetch the URL and extract the restaurant names first
     (use WebFetch / the deep-research approach; a "maps/heatmap" article usually has a clean
     ordered list of venue names).
2. **Constraints** (ask only if the user cares; otherwise use sensible defaults):
   - **date** → `--day YYYY-MM-DD` (default: pick the date the user means; if none, ask)
   - **party size** → `--party N` (default 2)
   - **time window** → `--start HH:MM --end HH:MM` in 24h local time (default: whole day)
   - city/region for venue search → `--lat/--long/--location` (default NYC)

If the user gives no constraints at all, still run — report all open times for the day so they can pick.

## Which platform to use

You usually don't know a restaurant's platform up front. **Default order: Resy first** (fastest,
covers the most NYC spots), then per-restaurant fall back to SevenRooms (= DoorDash Reservations)
and OpenTable for anything Resy didn't match. Most restaurants are on exactly one of the three
backends. A restaurant on *none* of them is rare — treat it as a coverage gap to investigate (see
"Coverage" below), not an expected outcome.

### 1. Resy — `scripts/resy.py` (needs the user's auth token)

Pure API, fast, parallel. **The `/4/find` endpoint returns HTTP 500 (not 401) without a user
token**, so a token is required:

- Get it: user opens devtools while logged in to resy.com → any XHR request → copy the
  `X-Resy-Auth-Token` request header (a long JWT). It's a bearer credential that **expires every
  few days** — re-grab when calls start failing. Ask the user to paste a fresh one.
- Provide it via `$RESY_TOKEN`, `--token`, or `~/.config/reservation-checker/resy_token.txt`.

```bash
RESY_TOKEN='eyJ...' python3 scripts/resy.py \
  --day 2026-07-20 --party 4 --start 18:00 --end 20:00 \
  --json /tmp/resy_out.json "Babbo" "Penny" "Jupiter"
# by slug instead of name:
RESY_TOKEN='eyJ...' python3 scripts/resy.py --slugs --day 2026-07-20 --party 4 babbo-ristorante
```

Names are matched via Resy's venue search (accent/case-insensitive). Output lines: `AVAILABLE`,
`NO WINDOW` (open other times — listed), `UNMATCHED` (not on Resy — shows closest matches so you
can sanity-check for false matches by address/neighborhood).

### 2. SevenRooms — `scripts/sevenrooms.py` (no auth, easiest) — also covers DoorDash Reservations

Fully open widget API, plain HTTP. **This same script covers DoorDash Reservations**, since
DoorDash is powered by SevenRooms — do not look for a separate DoorDash endpoint.

Per-restaurant work is finding the **slug** (path segment in `sevenrooms.com/reservations/<slug>`,
usually name + city, e.g. Baohaus → `baohausnyc`, Piccolo Morini → `piccolomorininyc`). By default
the script takes **names** and auto-tries slug variants (bare name, + `nyc`/`ny`/`newyork`, etc.),
using the first that resolves — so you usually don't need to know the slug:

```bash
# by name (auto-guesses the slug — preferred):
python3 scripts/sevenrooms.py --day 2026-07-20 --party 4 --start 18:00 --end 20:00 "Baohaus" "Piccolo Morini"
# by exact known slug:
python3 scripts/sevenrooms.py --exact --day 2026-07-20 --party 4 baohausnyc
# non-NYC: change the city suffix guess
python3 scripts/sevenrooms.py --city sf --day 2026-07-20 --party 4 "Some SF Spot"
```

Distinguishes **instant-book** (`BOOKABLE`) from **request-only** (`REQUEST` — restaurant must
confirm; not a guaranteed table). `NOT FOUND` means no slug variant resolved — before trusting it,
try the real slug from the venue's own "reserve"/SevenRooms link (see "Coverage"). Report the
instant-vs-request distinction to the user.

### 3. OpenTable — behind Akamai; **prefer the CDP ride-along** (`scripts/opentable_cdp.js`)

OpenTable is behind Akamai Bot Manager, which **resets the connection for every non-browser client**
(curl, headless Chrome, server-side fetchers) and, crucially, ties the `_abck` anti-bot token to the
**specific browser fingerprint** it was minted in. This is why the old cookie-injection path
(`scripts/opentable.js`) is unreliable: injecting a copied `Cookie:` header into a *fresh Playwright
Chrome* gives Akamai "valid cookie, wrong/robotic browser" (Playwright leaks `navigator.webdriver` /
CDP signals), so it serves a challenge — you get a first pageview that works, then **403 "Access
Denied"** or **"no availability request captured"** on everything after. Grabbing fresher cookies does
NOT fix this — the browser is the tell, not the cookie.

One-time setup (installs Playwright into `~/.cache/reservation-checker`, uses system Chrome), shared
by both methods:
```bash
bash scripts/setup_opentable.sh
```

#### 3a. Preferred: CDP ride-along — `scripts/opentable_cdp.js`

Don't copy cookies at all. **Attach to the user's REAL Chrome**, which already passed Akamai. Same
fingerprint, TLS, and validated session → indistinguishable from the user browsing.

1. Launch a dedicated Chrome with a debugging port + **separate** profile (a separate `--user-data-dir`
   is required — Chrome refuses remote debugging on a profile already open in another running Chrome),
   then have the user log in to opentable.com once in that window:
   ```bash
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
     --remote-debugging-port=9222 --user-data-dir=/tmp/ot-chrome-profile https://www.opentable.com/
   ```
2. Once they're logged in, run the checker (it attaches via `connectOverCDP`, reuses the open tab, and
   **scrapes the visible time-slot buttons** rather than replaying the GraphQL API — so there's no
   fragile request to capture):
   ```bash
   OT_DAY=2026-07-20 OT_PARTY=4 OT_START=18:00 OT_END=20:00 OT_TZ=America/New_York \
     node scripts/opentable_cdp.js '[{"name":"Zou Zous","slug":"zou-zous-new-york"}]'
   ```
   Override the endpoint with `OT_CDP=http://localhost:9222` if needed. Closing the script only
   disconnects CDP — it does **not** kill the user's Chrome. Output JSON per restaurant: `window`
   (slots inside the requested window) and `allFound` (all slots that day); an Akamai challenge is
   reported as `error: "akamai challenge (session not trusted)"`.

#### 3b. Fallback (legacy): cookie injection — `scripts/opentable.js`

Use only if the CDP path isn't possible (e.g. can't launch Chrome with a debug port). User copies the
raw `Cookie:` header from any logged-in opentable.com request in devtools into a file (session-bound
`_abck`/`bm_*` tokens **expire** — re-paste when calls fail; expect it to work for one or two venues
then start blocking):

```bash
OT_COOKIE_FILE=/path/to/ot_cookies.txt OT_DAY=2026-07-20 OT_PARTY=4 \
  OT_START=18:00 OT_END=20:00 OT_TZ=America/New_York \
  node scripts/opentable.js '[{"name":"Zaytinya","slug":"zaytinya-new-york"}]'
```

Both scripts take an OpenTable **slug** (path segment in `opentable.com/r/<slug>`) per target and query
6/7/8 PM anchors, unioning results to cover the window. `opentable.js` also auto-discovers the numeric
`restaurantId` (or pass `"rid": <number>`).

## Workflow

1. Resolve the restaurant list (extract names from any URLs first).
2. Confirm/assume constraints (date, party, window). Convert to script flags.
3. Run **Resy** for the whole list in one call (get token from user if not already have a fresh one).
4. For `UNMATCHED` restaurants, try **SevenRooms** (= DoorDash Reservations; pass names, it
   auto-guesses slugs) and **OpenTable** (prefer the CDP ride-along, §3a). Verify name matches by
   address/neighborhood to avoid false positives (e.g. a similarly-named different venue).

   **OpenTable-only shortcut.** If, after Resy + SevenRooms, the *only* remaining unchecked
   restaurants are ones that resolve on OpenTable (or the user explicitly asked for restaurants
   you know to be OpenTable-only), don't stop to ask how to proceed. Instead:
   - **First report everything you already have** (Resy + SevenRooms results) as a normal table,
     so the user isn't blocked waiting on OpenTable.
   - Then, in the same message, **set up the CDP ride-along** (§3a) for the remaining venue(s) —
     name them. Launch the debug-port Chrome yourself and ask the user only to *log in to
     opentable.com* in that window and say "go" (runs `setup_opentable.sh` once if not yet set up).
     As soon as they confirm, run `scripts/opentable_cdp.js` and fold the results into the table.
     Only fall back to asking for a pasted `Cookie:` header + `scripts/opentable.js` (§3b) if the
     CDP path isn't workable.
5. **Coverage check (do this every run).** Collect any restaurant that matched on *none* of the
   three backends and report it in a distinct **"⚠️ not found on any platform"** section — separate
   from "on a platform but no slots in your window." Coverage of reservation-taking restaurants
   should be **near 100%**, so a no-match is a red flag, usually a resolution miss, not a real gap.
   Before trusting it, for each unmatched name:
   - retry SevenRooms with the true slug (web-search "<name> sevenrooms reservations" or find the
     "Reserve" link on the restaurant's own site) and Resy by exact slug;
   - re-check for name ambiguity (city/neighborhood) that broke the match.
   Only after that, label it as genuinely not taking online reservations (walk-in only, phone-only,
   or a platform outside these three — e.g. Tock is a possibility). Say which, don't just drop it.
6. Report a clean table: restaurant → platform → open slots in the window (flag request-only vs
   instant), plus near-misses just outside the window, plus the coverage-gap section from step 5.

## Notes & gotchas

- **DoorDash Reservations = SevenRooms.** DoorDash bought SevenRooms and its reservations product
  is powered entirely by it (confirmed: Baohaus books via DoorDash and resolves on SevenRooms as
  `baohausnyc`). Never build/look for a separate DoorDash availability endpoint.
- Resy web page scraping is a **dead end** in automated browsers here (anonymous `/4/find` 500s) —
  always use the API with a token.
- **OpenTable: prefer CDP ride-along (§3a) over cookie injection (§3b).** Akamai binds `_abck` to the
  browser fingerprint, so a fresh Playwright Chrome with copied cookies gets challenged (403 /
  "no request captured") after ~1 venue. Attaching to the user's real, already-trusted Chrome and
  scraping the rendered slots is the robust path — verified to clear the block cleanly.
- All three checkers run restaurants in parallel; a full list resolves in ~seconds (Resy/SevenRooms).
- Tokens/cookies are **per-user, expiring bearer credentials**. If the user pastes one into chat,
  note that logging out/in on that site rotates it.
- Background on the working methods, IPs, and history is in the user's memory file
  `reservation-checker-toolkit`.
