#!/usr/bin/env python3
"""Radar de apuestas: datos reales -> modelo Poisson -> valor vs cuotas -> docs/index.html
Claves por variables de entorno: FOOTBALL_DATA_KEY y ODDS_API_KEY (ambas gratis)."""
import os, re, sys, json, math, time, csv, difflib, unicodedata, datetime as dt
from collections import defaultdict
from email.utils import parsedate_to_datetime
import xml.etree.ElementTree as ET
import requests

FD_KEY, OD_KEY = os.getenv("FOOTBALL_DATA_KEY"), os.getenv("ODDS_API_KEY")
FD, OD = "https://api.football-data.org/v4", "https://api.the-odds-api.com/v4"
# Competiciones activas. Para quitar Serie A (opcional), borra su línea en COMPS.
COMPS = {"PD": "soccer_spain_la_liga", "CL": "soccer_uefa_champs_league",
         "PL": "soccer_epl", "SA": "soccer_italy_serie_a"}
LABEL = {"PD": "LaLiga", "CL": "Champions", "PL": "Premier", "SA": "Serie A"}
DAYS, MAX_TENNIS, MARGIN = 3, 6, 0.94
BAD = ("lesion", "lesión", "injur", "baja", "out for", "doubt", "duda", "suspend", "sancion", "ruled out", "miss")
NOW = dt.datetime.now(dt.timezone.utc)

def get(url, **kw):
    try:
        r = requests.get(url, timeout=25, **kw)
        if r.status_code != 200:
            print("AVISO", r.status_code, url.split("?")[0]); return None
        return r
    except Exception as e:
        print("AVISO", e); return None

# ---------- 1. Resultados y calendario (football-data.org, gratis) ----------
def fetch_matches():
    fin, up = [], []
    for code in COMPS:
        r = get(f"{FD}/competitions/{code}/matches", headers={"X-Auth-Token": FD_KEY or ""})
        time.sleep(7)  # plan gratis: 10 peticiones/minuto
        if not r: continue
        for m in r.json().get("matches", []):
            m["code"] = code
            d = dt.datetime.fromisoformat(m["utcDate"].replace("Z", "+00:00"))
            m["dt"] = d
            if m["status"] == "FINISHED" and m["score"]["fullTime"]["home"] is not None: fin.append(m)
            elif NOW <= d <= NOW + dt.timedelta(days=DAYS) and m["status"] in ("SCHEDULED", "TIMED"): up.append(m)
    return fin, up

# ---------- 2. Modelo: fuerza de ataque/defensa con peso por recencia ----------
def fit_ratings(fin, k=4, iters=15):
    rows = [(m["homeTeam"]["id"], m["awayTeam"]["id"], m["score"]["fullTime"]["home"],
             m["score"]["fullTime"]["away"], math.exp(-(NOW - m["dt"]).days / 90)) for m in fin]
    W = sum(r[4] for r in rows)
    aH = sum(r[2] * r[4] for r in rows) / W; aA = sum(r[3] * r[4] for r in rows) / W
    att, dfn = defaultdict(lambda: 1.0), defaultdict(lambda: 1.0)
    for _ in range(iters):
        na, nd = {}, {}
        num_a, den_a, num_d, den_d = (defaultdict(float) for _ in range(4))
        for h, a, gh, ga, w in rows:
            num_a[h] += w * gh; den_a[h] += w * aH * dfn[a]
            num_a[a] += w * ga; den_a[a] += w * aA * dfn[h]
            num_d[h] += w * ga; den_d[h] += w * aA * att[a]
            num_d[a] += w * gh; den_d[a] += w * aH * att[h]
        for t in set(num_a) | set(num_d):
            na[t] = (num_a[t] + k) / (den_a[t] + k); nd[t] = (num_d[t] + k) / (den_d[t] + k)
        att.update(na); dfn.update(nd)
    return att, dfn, aH, aA

def pois(l, n=11):
    p, out = math.exp(-l), []
    for i in range(n): out.append(p); p *= l / (i + 1)
    return out

def probs(lh, la):
    ph, pa = pois(lh), pois(la); r = dict(p1=0, px=0, p2=0, o15=0, o25=0, btts=0)
    for i, x in enumerate(ph):
        for j, y in enumerate(pa):
            p = x * y
            r["p1" if i > j else "px" if i == j else "p2"] += p
            if i + j >= 2: r["o15"] += p
            if i + j >= 3: r["o25"] += p
            if i and j: r["btts"] += p
    return r

# ---------- 3. Noticias gratis (Google News RSS) ----------
def news(team):
    q = requests.utils.quote(f'"{team}" lesión OR injury OR baja')
    r = get(f"https://news.google.com/rss/search?q={q}&hl=es&gl=ES&ceid=ES:es"); time.sleep(0.4)
    hits, heads = 0, []
    if not r: return 0, []
    try:
        for it in ET.fromstring(r.content).iter("item"):
            t, d = it.findtext("title", ""), parsedate_to_datetime(it.findtext("pubDate"))
            if (NOW - d).days <= 3:
                heads.append(t)
                hits += any(b in t.lower() for b in BAD)
    except Exception: pass
    return min(hits, 3), heads[:2]

# ---------- 4. Cuotas reales (The Odds API, gratis 500 créditos/mes) ----------
def norm(n):
    n = unicodedata.normalize("NFKD", n).encode("ascii", "ignore").decode().lower()
    return re.sub(r"\b(fc|cf|ac|as|sc|afc|ssc|us|ud|rc|cd|sv|vfb|vfl|fsv|tsg|1)\b|[.']", "", n).strip()

def fetch_odds(sport, markets="h2h,totals"):
    if not OD_KEY: return []
    r = get(f"{OD}/sports/{sport}/odds/", params=dict(apiKey=OD_KEY, regions="eu", markets=markets, oddsFormat="decimal"))
    return r.json() if r else []

def best_prices(ev):
    b = {}
    for bk in ev.get("bookmakers", []):
        for mk in bk["markets"]:
            for o in mk["outcomes"]:
                key = (mk["key"], o["name"], o.get("point"))
                if o["price"] > b.get(key, (0,))[0]: b[key] = (o["price"], bk["title"])
    return b

def match_event(evs, h, a):
    best, sc = None, 0.6
    for ev in evs:
        s = min(difflib.SequenceMatcher(None, norm(h), norm(ev["home_team"])).ratio(),
                difflib.SequenceMatcher(None, norm(a), norm(ev["away_team"])).ratio())
        if s > sc: best, sc = ev, s
    return best

# ---------- 5. Fútbol ----------
def football():
    fin, up = fetch_matches()
    if not fin: print("Sin datos de football-data.org (¿clave?)"); return []
    att, dfn, aH, aA = fit_ratings(fin)
    odds = {c: fetch_odds(s) for c, s in COMPS.items()} if OD_KEY else {}
    out = []
    for m in sorted(up, key=lambda x: x["dt"]):
        h, a = m["homeTeam"], m["awayTeam"]; hn, an = h.get("shortName") or h["name"], a.get("shortName") or a["name"]
        nh, hh = news(hn); na, ha = news(an)
        lh = aH * att[h["id"]] * 0.97 ** nh * dfn[a["id"]] / 0.97 ** na
        la = aA * att[a["id"]] * 0.97 ** na * dfn[h["id"]] / 0.97 ** nh
        p = probs(lh, la)
        row = dict(d=m["dt"].isoformat(), c=LABEL[m["code"]], h=hn, a=an, xg=[round(lh, 2), round(la, 2)],
                   p={k: round(v, 4) for k, v in p.items()}, news=hh + ha, flags=[nh, na], odds={})
        ev = match_event(odds.get(m["code"], []), h["name"], a["name"])
        if ev:
            b = best_prices(ev)
            for k, key in (("p1", ("h2h", ev["home_team"], None)), ("px", ("h2h", "Draw", None)),
                           ("p2", ("h2h", ev["away_team"], None)), ("o25", ("totals", "Over", 2.5)), ("u25", ("totals", "Under", 2.5))):
                if key in b: row["odds"][k] = dict(o=b[key][0], bk=b[key][1])
        out.append(row)
    return out

# ---------- 6. Tenis (Odds API + CSV manual para Challengers) ----------
def tennis():
    out = []
    if OD_KEY:
        r = get(f"{OD}/sports/", params=dict(apiKey=OD_KEY))
        allt = [s for s in (r.json() if r else []) if s["key"].startswith("tennis_") and s.get("active")]
        print("Torneos de tenis disponibles en la API:", [s["key"] for s in allt])
        # Challengers primero; si la API no los cubre, entran los demás torneos activos
        allt.sort(key=lambda s: "challenger" not in (s["key"] + s["title"]).lower())
        keys = allt[:MAX_TENNIS]
        for s in keys:
            for ev in fetch_odds(s["key"], "h2h"):
                b = best_prices(ev); oa, ob = b.get(("h2h", ev["home_team"], None)), b.get(("h2h", ev["away_team"], None))
                if not (oa and ob): continue
                z = 1 / oa[0] + 1 / ob[0]
                out.append(dict(t=s["title"], a=ev["home_team"], b=ev["away_team"], pa=round(1 / oa[0] / z, 4),
                                oa=oa[0], ob=ob[0], d=ev["commence_time"], src="cuotas reales"))
    if os.path.exists("tennis_manual.csv"):
        for r in csv.DictReader(open("tennis_manual.csv", encoding="utf-8")):
            ra, rb = float(r["rank_a"]), float(r["rank_b"])
            pa = 1 / (1 + math.exp(-0.55 * math.log(rb / ra)))  # modelo simple por ranking
            if r.get("odds_a") and r.get("odds_b"):
                oa, ob = float(r["odds_a"]), float(r["odds_b"]); z = 1 / oa + 1 / ob
                pa = 0.5 * pa + 0.5 * (1 / oa / z)
            else: oa = ob = None
            out.append(dict(t=r.get("torneo", "Challenger"), a=r["player_a"], b=r["player_b"], pa=round(pa, 4),
                            oa=oa, ob=ob, d=r.get("fecha", ""), src="manual (ranking" + ("+cuotas)" if oa else ")"), note=r.get("notas", "")))
    return out

# ---------- 7. Salida web ----------
HTML = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "template.html"), encoding="utf-8").read()
def main():
    data = dict(updated=NOW.strftime("%d/%m/%Y %H:%M UTC"), football=football(), tennis=tennis(), margin=MARGIN)
    os.makedirs("docs", exist_ok=True)
    open("docs/data.json", "w", encoding="utf-8").write(json.dumps(data, ensure_ascii=False))
    open("docs/index.html", "w", encoding="utf-8").write(HTML.replace("__DATA__", json.dumps(data, ensure_ascii=False)))
    print("OK:", len(data["football"]), "partidos,", len(data["tennis"]), "de tenis")
if __name__ == "__main__": main()
