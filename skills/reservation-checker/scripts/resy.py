#!/usr/bin/env python3
"""Check Resy availability for restaurants, by NAME or by SLUG.

Examples:
  RESY_TOKEN=eyJ... python3 resy.py --day 2026-07-20 --party 4 --start 18:00 --end 20:00 "Babbo" "Penny"
  RESY_TOKEN=eyJ... python3 resy.py --slugs --day 2026-07-20 --party 4 babbo-ristorante jupiter-nyc

Inputs: restaurant names (default) or --slugs (Resy url_slug, the path segment in resy.com/cities/<city>/venues/<slug>).
Read from positional args and/or stdin (one per line).

Auth: Resy's /4/find endpoint 500s without a user token. Provide a JWT via (in order):
  --token, $RESY_TOKEN, or ~/.config/reservation-checker/resy_token.txt
Get it from browser devtools while logged into resy.com -> any XHR -> request header
"X-Resy-Auth-Token" (a long JWT). It expires every few days; re-grab when calls start failing.

Output: one line per restaurant (AVAILABLE / NO WINDOW / UNMATCHED / ERROR) plus JSON to --json path.
"""
import argparse, json, os, subprocess, sys, unicodedata
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

API_KEY = 'VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5'  # public Resy web api_key, safe to hardcode
TOKEN_FILE = Path.home() / '.config' / 'reservation-checker' / 'resy_token.txt'


def load_token(cli_token):
    if cli_token:
        return cli_token.strip()
    if os.environ.get('RESY_TOKEN'):
        return os.environ['RESY_TOKEN'].strip()
    if TOKEN_FILE.exists():
        return TOKEN_FILE.read_text().strip()
    sys.exit('No Resy token. Pass --token, set $RESY_TOKEN, or write it to %s' % TOKEN_FILE)


def hdrs(token):
    return [
        '-H', 'Authorization: ResyAPI api_key="%s"' % API_KEY,
        '-H', 'X-Resy-Auth-Token: %s' % token,
        '-H', 'X-Resy-Universal-Auth: %s' % token,
        '-H', 'X-Origin: https://resy.com',
        '-H', 'Origin: https://resy.com',
        '-H', 'Referer: https://resy.com/',
        '-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
              '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    ]


def curl_json(url, token, post_body=None):
    cmd = ['curl', '-s', '--max-time', '25', *hdrs(token)]
    if post_body is not None:
        cmd += ['-H', 'Content-Type: application/json', '-d', json.dumps(post_body)]
    out = subprocess.run(cmd + [url], capture_output=True, text=True).stdout
    try:
        return json.loads(out)
    except Exception:
        return {'_raw': out[:200]}


def norm(s):
    s = unicodedata.normalize('NFKD', s or '').encode('ascii', 'ignore').decode()
    return ''.join(c for c in s.lower() if c.isalnum())


def fmt_time(t24):
    h, m = int(t24[:2]), t24[3:5]
    ap = 'PM' if h >= 12 else 'AM'
    h12 = h - 12 if h > 12 else (12 if h == 0 else h)
    return '%d:%s %s' % (h12, m, ap)


def resolve_by_slug(slug, cfg):
    v = curl_json('https://api.resy.com/3/venue?url_slug=%s&location=%s' % (slug, cfg['location']),
                  cfg['token'])
    vid = (v.get('id') or {}).get('resy') if isinstance(v.get('id'), dict) else None
    if not vid:
        return None, slug, None, 'venue lookup failed: %s' % str(v)[:120]
    return vid, v.get('name', slug), None, None


def resolve_by_name(name, cfg):
    body = {'geo': {'latitude': cfg['lat'], 'longitude': cfg['long'], 'radius': 35420},
            'per_page': 5, 'query': name, 'types': ['venue']}
    d = curl_json('https://api.resy.com/3/venuesearch/search', cfg['token'], body)
    hits = (d.get('search') or {}).get('hits') or []
    target = norm(name)
    best = None
    for h in hits:
        hn = norm(h.get('name'))
        if hn == target:
            best = h
            break
        if best is None and (target in hn or hn in target) and abs(len(hn) - len(target)) <= 12:
            best = h
    if not best:
        return None, name, None, 'not found on Resy (closest: %s)' % [h.get('name') for h in hits[:3]]
    vid = best.get('id', {}).get('resy') if isinstance(best.get('id'), dict) else best.get('id')
    matched = best.get('name')
    if norm(matched) != target:
        matched = '%s [%s]' % (name, ', '.join(filter(None, [best.get('name'), best.get('locality')])))
    return vid, matched, best.get('url_slug'), None


def check(item, cfg):
    if cfg['slugs']:
        vid, name, slug, err = resolve_by_slug(item, cfg)
    else:
        vid, name, slug, err = resolve_by_name(item, cfg)
    if err:
        return {'query': item, 'name': name, 'window': None, 'all_times': None, 'err': err}
    f = curl_json('https://api.resy.com/4/find?lat=%s&long=%s&day=%s&party_size=%s&venue_id=%s'
                  % (cfg['lat'], cfg['long'], cfg['day'], cfg['party'], vid), cfg['token'])
    try:
        venues = f['results']['venues']
        slots = venues[0]['slots'] if venues else []
    except Exception:
        return {'query': item, 'name': name, 'window': None, 'all_times': None,
                'err': 'find failed: %s' % str(f)[:150]}
    hits, all_times = [], []
    for s in slots:
        start = s.get('date', {}).get('start', '')
        t = start.split(' ')[1][:5] if ' ' in start else ''
        if not t:
            continue
        typ = (s.get('config', {}).get('type', '') or '')
        all_times.append(t)
        if cfg['start'] <= t <= cfg['end']:
            hits.append(fmt_time(t) + (' (%s)' % typ if typ and typ.lower() != 'dining room' else ''))
    return {'query': item, 'name': name, 'slug': slug,
            'window': hits, 'all_times': sorted(set(all_times)), 'err': None}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('items', nargs='*', help='restaurant names (or slugs with --slugs)')
    ap.add_argument('--slugs', action='store_true', help='treat inputs as Resy url_slugs')
    ap.add_argument('--day', required=True, help='YYYY-MM-DD')
    ap.add_argument('--party', default='2')
    ap.add_argument('--start', default='00:00', help='window start HH:MM (24h)')
    ap.add_argument('--end', default='23:59', help='window end HH:MM (24h)')
    ap.add_argument('--lat', default='40.73')
    ap.add_argument('--long', default='-73.99')
    ap.add_argument('--location', default='new-york-ny', help='city slug for --slugs lookups')
    ap.add_argument('--token', default=None)
    ap.add_argument('--json', default=None, help='write full results to this path')
    ap.add_argument('--workers', type=int, default=8)
    a = ap.parse_args()

    items = list(a.items) + [l.strip() for l in sys.stdin if not sys.stdin.isatty() and l.strip()] \
        if not sys.stdin.isatty() else list(a.items)
    if not items:
        sys.exit('No restaurants given (pass as args or pipe one-per-line on stdin).')

    cfg = {'slugs': a.slugs, 'day': a.day, 'party': a.party, 'start': a.start, 'end': a.end,
           'lat': a.lat, 'long': a.long, 'location': a.location, 'token': load_token(a.token)}

    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        results = list(ex.map(lambda it: check(it, cfg), items))

    if a.json:
        json.dump(results, open(a.json, 'w'), indent=1, default=str)

    def sortkey(r):
        return (r['err'] is not None, not (r['window'] or []), (r['name'] or '').lower())
    for r in sorted(results, key=sortkey):
        label = r['name'] or r['query']
        if r['err']:
            print('UNMATCHED | %s | %s' % (label, r['err']))
        elif r['window']:
            print('AVAILABLE | %s | %s' % (label, ', '.join(r['window'])))
        else:
            other = ', '.join(fmt_time(t) for t in (r['all_times'] or [])) or 'none all day'
            print('NO WINDOW | %s | other times: %s' % (label, other))


if __name__ == '__main__':
    main()
