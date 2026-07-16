#!/usr/bin/env python3
"""Check SevenRooms availability. Fully open API — no auth, plain HTTP.

**This also covers DoorDash Reservations**, which is 100% powered by SevenRooms: a restaurant
bookable "on DoorDash" is the same SevenRooms venue under the hood (DoorDash is just a discovery
front-end). So checking SevenRooms == checking DoorDash Reservations. No separate DoorDash API.

Usage:
  # by name (auto-guesses slug variants, incl. city suffix — best for coverage):
  python3 sevenrooms.py --day 2026-07-20 --party 4 --start 18:00 --end 20:00 "Baohaus" "Piccolo Morini"
  # by exact known slug (skip guessing):
  python3 sevenrooms.py --exact --day 2026-07-20 --party 4 baohausnyc piccolomorininyc

Slug = path segment in https://www.sevenrooms.com/reservations/<slug>. Often name+city, e.g.
"Baohaus" -> baohausnyc, "Piccolo Morini" -> piccolomorininyc. By default this tries a handful of
candidate slugs per name and uses the first that resolves; pass --city to change the suffix guess
(default nyc). Distinguishes instant-book ("book") from request-only ("request") slots.
"""
import argparse, json, subprocess, sys, unicodedata
from concurrent.futures import ThreadPoolExecutor


def norm(s):
    s = unicodedata.normalize('NFKD', s or '').encode('ascii', 'ignore').decode()
    return ''.join(c for c in s.lower() if c.isalnum())


def slug_candidates(item, city, exact):
    """Ordered slug guesses. The literal input is always tried first so known slugs still work."""
    cands = [item.strip()]
    if exact:
        return cands
    base = norm(item)
    if base and base not in cands:
        cands.append(base)
    for suffix in (city, 'ny', 'newyork', 'restaurant'):
        c = base + suffix
        if c not in cands:
            cands.append(c)
    the = 'the' + base
    if the not in cands:
        cands.append(the)
    return cands


def fetch(slug, cfg):
    """Return (status_ok, availability_shifts) for one slug, or (False, None) if invalid."""
    day_mdy = '%s-%s-%s' % (cfg['day'][5:7], cfg['day'][8:10], cfg['day'][0:4])  # MM-DD-YYYY
    url = ('https://www.sevenrooms.com/api-yoa/availability/widget/range?venue=%s'
           '&time_slot=19:00&party_size=%s&halo_size_interval=16'
           '&start_date=%s&num_days=1&channel=SEVENROOMS_WIDGET' % (slug, cfg['party'], day_mdy))
    out = subprocess.run(['curl', '-s', '--max-time', '25', '-H', 'User-Agent: Mozilla/5.0', url],
                         capture_output=True, text=True).stdout
    try:
        d = json.loads(out)
        if d.get('status') and d['status'] != 200:
            return False, None
        return True, d['data']['availability'].get(cfg['day'], [])
    except Exception:
        return False, None


def check(item, cfg):
    matched, shifts = None, None
    for cand in slug_candidates(item, cfg['city'], cfg['exact']):
        ok, sh = fetch(cand, cfg)
        if ok:
            matched, shifts = cand, sh
            break
    if matched is None:
        return {'query': item, 'slug': None, 'book': None, 'request': None,
                'err': 'no SevenRooms venue (tried %d slug guesses)' % len(slug_candidates(item, cfg['city'], cfg['exact']))}
    book, request = [], []
    for sh in shifts:
        for t in sh.get('times', []):
            iso = t.get('time_iso', '')
            hm = iso[11:16] if len(iso) >= 16 else ''
            if cfg['start'] <= hm <= cfg['end']:
                (book if t.get('type') == 'book' else request).append(t['time'])
    return {'query': item, 'slug': matched, 'book': sorted(set(book)),
            'request': sorted(set(request)), 'err': None}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('items', nargs='+', help='restaurant names (default) or slugs (with --exact)')
    ap.add_argument('--exact', action='store_true', help='treat inputs as exact slugs, no guessing')
    ap.add_argument('--city', default='nyc', help='slug suffix to guess (default nyc)')
    ap.add_argument('--day', required=True, help='YYYY-MM-DD')
    ap.add_argument('--party', default='2')
    ap.add_argument('--start', default='00:00')
    ap.add_argument('--end', default='23:59')
    ap.add_argument('--json', default=None)
    a = ap.parse_args()
    cfg = {'day': a.day, 'party': a.party, 'start': a.start, 'end': a.end,
           'city': a.city, 'exact': a.exact}

    with ThreadPoolExecutor(max_workers=6) as ex:
        results = list(ex.map(lambda s: check(s, cfg), a.items))

    if a.json:
        json.dump(results, open(a.json, 'w'), indent=1)

    for r in results:
        tag = r['slug'] or r['query']
        if r['err']:
            print('NOT FOUND | %s | %s' % (r['query'], r['err']))
        elif r['book']:
            line = 'BOOKABLE | %s | instant: %s' % (tag, ', '.join(r['book']))
            if r['request']:
                line += ' | request-only: %s' % ', '.join(r['request'])
            print(line)
        elif r['request']:
            print('REQUEST  | %s | request-only: %s' % (tag, ', '.join(r['request'])))
        else:
            print('NONE     | %s | on SevenRooms/DoorDash but no slots in window' % tag)


if __name__ == '__main__':
    main()
