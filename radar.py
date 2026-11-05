#!/usr/bin/env python3
"""Radar de apuestas: datos reales -> modelo Poisson -> valor vs cuotas -> docs/index.html
Claves por variables de entorno: FOOTBALL_DATA_KEY y ODDS_API_KEY (ambas gratis)."""
import os, re, sys, json, math, time, csv, shutil, hashlib, difflib, unicodedata, datetime as dt
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
    ph, pa = pois(lh), pois(la); r = dict(p1=0, px=0, p2=0, o05=0, o15=0, o25=0, o35=0, btts=0)
    for i, x in enumerate(ph):
        for j, y in enumerate(pa):
            p = x * y
            r["p1" if i > j else "px" if i == j else "p2"] += p
            if i + j >= 1: r["o05"] += p
            if i + j >= 1: r["o05"] += p
            if i + j >= 2: r["o15"] += p
            if i + j >= 3: r["o25"] += p
            if i + j >= 4: r["o35"] += p
            if i and j: r["btts"] += p
    return r

# ---------- 3. Noticias: clasificadas por tipo e impacto (Google News RSS, sin clave) ----------
CATS = [("baja", -0.04, r"ruled out|out for|sidelined|fractur\w*|rotura|se pierde|\bbajas?\b|operad\w*|surgery|injur\w*|lesi[oó]n\w*|lesionad\w*|withdr\w*|retir\w*|abandon\w*"),
        ("sanción", -0.03, r"suspend\w*|sanci[oó]n\w*|sancionad\w*|red card|expulsad\w*|\bban(ned)?\b"),
        ("duda", -0.02, r"doubt\w*|\bduda\w*|tocado|molestias|fitness|knock|fatig\w*"),
        ("regreso", 0.02, r"\breturn\w*|vuelve|regresa|recupera\w*|back in training|recovered|comeback"),
        ("entrenador", 0.0, r"sacked|despid\w*|cesad\w*|new manager|nuevo entrenador|dimit\w*|resign\w*")]
CATS = [(c, w, re.compile(p, re.I)) for c, w, p in CATS]
SEV = {"baja": 0, "sanción": 1, "duda": 2, "regreso": 3, "entrenador": 4, "otras": 5}
def classify(title):
    for c, w, rx in CATS:
        if rx.search(title): return c, w
    return "otras", 0.0
_NEWS = {}
def news_items(name, sport="football"):
    """Titulares de los últimos 4 días clasificados. El impacto se limita a [-9 %, +4 %] y cuenta como mucho 2 titulares por categoría."""
    if name in _NEWS: return _NEWS[name]
    qs = [f'"{name}" lesión OR baja OR injury OR suspended OR doubt', f'"{name}" previa OR forma OR preview'] if sport == "football" else \
         [f'"{name}" tenis lesión OR retirada OR withdraw OR injury', f'"{name}" tennis form OR win OR loss']
    items, seen = [], set()
    for q in qs:
        r = get("https://news.google.com/rss/search?q=" + requests.utils.quote(q) + "&hl=es&gl=ES&ceid=ES:es"); time.sleep(0.4)
        if not r: continue
        try:
            for it in ET.fromstring(r.content).iter("item"):
                t = (it.findtext("title") or "").strip(); d = parsedate_to_datetime(it.findtext("pubDate"))
                days = (NOW - d).days
                if days > 4 or not t: continue
                k = norm(t)[:55]
                if k in seen: continue
                seen.add(k); c, w = classify(t); src = (it.findtext("source") or "").strip()
                items.append(dict(title=t, src=src, link=it.findtext("link") or "", date=d.isoformat(), days=days, cat=c, w=w))
        except Exception: pass
    items.sort(key=lambda x: (SEV[x["cat"]], x["days"]))
    cnt, imp = defaultdict(int), 0.0
    for x in items:
        if x["w"] and cnt[x["cat"]] < 2: cnt[x["cat"]] += 1; imp += x["w"]
    res = dict(items=items[:8], impact=round(max(-0.09, min(0.04, imp)), 3), neg=sum(1 for x in items if x["w"] < 0))
    _NEWS[name] = res; return res

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

# ---------- 5. Versionado de modelo (model_config.json) ----------
BASE_VERSION, TENNIS_VERSION = "poisson-v1.1", "tennis-rank-v1.1"
def load_config():
    try: c = json.load(open("model_config.json", encoding="utf-8"))
    except Exception: c = {}
    c.setdefault("champion", {}); c["champion"].setdefault("version", BASE_VERSION); c["champion"].setdefault("calibration", {})
    c.setdefault("candidate", None); c.setdefault("auto_learn", True)
    return c

def calp(p, cal):
    if not cal: return p
    p = min(max(p, 1e-4), 1 - 1e-4); z = math.log(p / (1 - p))
    return 1 / (1 + math.exp(-(cal["a"] * z + cal["b"])))

KEYS = {"o05": "goals_over_0.5", "o15": "goals_over_1.5", "o25": "goals_over_2.5", "o35": "goals_over_3.5", "btts": "btts"}
def calibrate(p, mdl):
    return {**p, **{k: calp(p[k], (mdl.get("calibration") or {}).get(v)) for k, v in KEYS.items()}}

def mk_vars(p, lh, la, odds):
    mk = None
    if all(k in odds for k in ("p1", "px", "p2")):
        z = sum(1 / odds[k]["o"] for k in ("p1", "px", "p2"))
        mk = {c: round(1 / odds[k]["o"] / z, 4) for c, k in (("1", "p1"), ("X", "px"), ("2", "p2"))}
    mo = None
    if "o25" in odds and "u25" in odds:
        mo = round((1 / odds["o25"]["o"]) / (1 / odds["o25"]["o"] + 1 / odds["u25"]["o"]), 4)
    V = [dict(id="1x2", metric="result_1x2", type="multiclass", market_p=mk,
              probs={"1": round(p["p1"], 4), "X": round(p["px"], 4), "2": round(p["p2"], 4)})]
    for k, line in (("o05", 0.5), ("o15", 1.5), ("o25", 2.5), ("o35", 3.5)):
        V.append(dict(id=KEYS[k], metric="goals_total", type="binary", test="over", line=line, p=round(p[k], 4), market_p=mo if k == "o25" else None))
    V.append(dict(id="btts", metric="btts", type="binary", test="true", p=round(p["btts"], 4), market_p=None))
    V.append(dict(id="goals_total_expected", metric="goals_total", type="numeric", expected=round(lh + la, 3)))
    return V

# ---------- 6. Estadísticas de equipo (forma, goles, ambos marcan…) a partir de los resultados reales ----------
def build_index(fin):
    idx, names = defaultdict(list), {}
    for m in sorted(fin, key=lambda x: x["dt"]):
        h, a, ft = m["homeTeam"], m["awayTeam"], m["score"]["fullTime"]
        names[h["id"]] = h.get("shortName") or h["name"]; names[a["id"]] = a.get("shortName") or a["name"]
        idx[h["id"]].append((m["dt"], True, ft["home"], ft["away"], a["id"])); idx[a["id"]].append((m["dt"], False, ft["away"], ft["home"], h["id"]))
    return idx, names

def form(idx, tid, n, home=None):
    g = [x for x in idx.get(tid, []) if home is None or x[1] == home][-n:]
    if not g: return None
    seq = "".join("V" if x[2] > x[3] else "E" if x[2] == x[3] else "D" for x in g); k = len(g)
    return dict(n=k, seq=seq, gf=round(sum(x[2] for x in g) / k, 2), ga=round(sum(x[3] for x in g) / k, 2),
                btts=round(sum(1 for x in g if x[2] and x[3]) / k, 2), o25=round(sum(1 for x in g if x[2] + x[3] >= 3) / k, 2),
                o15=round(sum(1 for x in g if x[2] + x[3] >= 2) / k, 2), cs=round(sum(1 for x in g if x[3] == 0) / k, 2), fts=round(sum(1 for x in g if x[2] == 0) / k, 2))

def h2h(idx, h, a, names):
    out = [(x[0], x[1], x[2], x[3]) for x in idx.get(h, []) if x[4] == a][-3:]
    return [f"{d.strftime('%d/%m/%y')}: {names[h] if hm else names[a]} {gf}-{ga} {names[a] if hm else names[h]}" for d, hm, gf, ga in out]

# ---------- 7. Picks recomendados con su razonamiento ----------
def options(r):
    p, o, H, A = r["p"], r["odds"], r["h"], r["a"]
    O = lambda k: o[k]["o"] if k in o else None
    res = lambda v, t="eq": dict(metric="result_1x2", test=t, value=v)
    gt = lambda t, l: dict(metric="goals_total", test=t, line=l)
    return [dict(kind="win_h", label=f"Gana {H}", p=p["p1"], odds=O("p1"), variable=res("1")), dict(kind="win_a", label=f"Gana {A}", p=p["p2"], odds=O("p2"), variable=res("2")),
            dict(kind="draw", label="Empate", p=p["px"], odds=O("px"), variable=res("X")),
            dict(kind="dc_h", label=f"{H} o empate", p=p["p1"] + p["px"], odds=None, variable=res(["1", "X"], "in")), dict(kind="dc_a", label=f"{A} o empate", p=p["px"] + p["p2"], odds=None, variable=res(["X", "2"], "in")),
            dict(kind="o15", label="Más de 1.5 goles", p=p["o15"], odds=None, variable=gt("over", 1.5)), dict(kind="o25", label="Más de 2.5 goles", p=p["o25"], odds=O("o25"), variable=gt("over", 2.5)),
            dict(kind="u25", label="Menos de 2.5 goles", p=1 - p["o25"], odds=O("u25"), variable=gt("under", 2.5)), dict(kind="o35", label="Más de 3.5 goles", p=p["o35"], odds=None, variable=gt("over", 3.5)),
            dict(kind="u35", label="Menos de 3.5 goles", p=1 - p["o35"], odds=None, variable=gt("under", 3.5)),
            dict(kind="btts", label="Ambos marcan: sí", p=p["btts"], odds=None, variable=dict(metric="btts", test="true")), dict(kind="nobtts", label="Ambos marcan: no", p=1 - p["btts"], odds=None, variable=dict(metric="btts", test="false"))]
GROUP = {"win_h": "res", "win_a": "res", "draw": "res", "dc_h": "res", "dc_a": "res", "o15": "goals", "o25": "goals", "u25": "goals", "o35": "goals", "u35": "goals", "btts": "btts", "nobtts": "btts"}

def why(op, r, F):
    """Argumentos A FAVOR y EN CONTRA, construidos solo con datos reales (modelo, resultados, cuotas, noticias)."""
    k, p, H, A = op["kind"], op["p"], r["h"], r["a"]; pro, con = [], []
    fh, fa, hh, aa = F["h_home"], F["a_away"], F["h_all"], F["a_all"]
    pro.append(f"Modelo: {p:.0%} (cuota justa {1 / p:.2f}).")
    if op["odds"]: 
        e = p * op["odds"] - 1
        (pro if e > 0 else con).append(f"Mejor cuota del mercado @{op['odds']:.2f}: {'valor' if e > 0 else 'sin valor'} {e:+.0%}.")
    lh, la = r["xg"]
    if k in ("win_h", "win_a", "draw", "dc_h", "dc_a"):
        pro.append(f"Goles esperados: {H} {lh} – {A} {la}.")
        fav, favf, oth, othf = (H, fh, A, fa) if k in ("win_h", "dc_h") else (A, fa, H, fh)
        if k in ("win_h", "win_a", "dc_h", "dc_a"):
            if favf: pro.append(f"{fav}: {favf['seq']} en sus últimos {favf['n']} {'en casa' if fav == H else 'fuera'} ({favf['gf']} goles a favor y {favf['ga']} en contra de media).")
            if othf: (con if othf["seq"].count("V") >= 3 else pro).append(f"{oth}: {othf['seq']} en sus últimos {othf['n']} {'en casa' if oth == H else 'fuera'}.")
        if k == "draw" and hh and aa: pro.append(f"Empates recientes: {hh['seq'].count('E')} de {hh['n']} ({H}) y {aa['seq'].count('E')} de {aa['n']} ({A}).")
        if k in ("dc_h", "dc_a"): con.append("La doble oportunidad paga menos: la cuota es baja aunque la probabilidad sea alta.")
        if F["h2h"]: pro.append("Últimos cruces: " + "; ".join(F["h2h"]) + ".")
    elif k in ("o15", "o25", "o35"):
        pro.append(f"Goles esperados totales: {lh + la:.1f} ({H} {lh}, {A} {la}).")
        key = {"o15": "o15", "o25": "o25", "o35": "o25"}[k]; ln = {"o15": 1.5, "o25": 2.5, "o35": 3.5}[k]
        if fh and fa: pro.append(f"{H} superó {ln if k != 'o35' else 2.5} goles en {fh[key]:.0%} de sus últimos {fh['n']} en casa; {A} en {fa[key]:.0%} de sus últimos {fa['n']} fuera.")
        if fh and fa and (fh[key] < .4 or fa[key] < .4): con.append("Uno de los dos equipos suele jugar partidos cerrados.")
    elif k in ("u25", "u35"):
        pro.append(f"Goles esperados totales: {lh + la:.1f}.")
        if fh and fa: pro.append(f"Defensas: {H} encaja {fh['ga']} en casa y {A} {fa['ga']} fuera de media; porterías a cero {fh['cs']:.0%} / {fa['cs']:.0%}.")
        if lh + la > 2.7: con.append("Los goles esperados son altos para una apuesta de pocos goles.")
    elif k == "btts":
        if fh and fa: pro.append(f"Ambos marcaron en {fh['btts']:.0%} de los últimos {fh['n']} de {H} en casa y en {fa['btts']:.0%} de los de {A} fuera.")
        if fh and fa and (fh["fts"] >= .4 or fa["fts"] >= .4): con.append("Alguno de los dos se quedó sin marcar en el 40 % o más de sus últimos partidos.")
    elif k == "nobtts":
        if fh and fa: pro.append(f"{H} dejó su portería a cero en {fh['cs']:.0%} de sus últimos {fh['n']} en casa; {A} no marcó en {fa['fts']:.0%} de los suyos fuera.")
    backed = "h" if k in ("win_h", "dc_h") else "a" if k in ("win_a", "dc_a") else None
    for side, nm in (("h", H), ("a", A)):
        n = F["news"][side]
        if not n["items"] or n["impact"] == 0: continue
        txt = f"Noticias de {nm}: impacto estimado {n['impact']:+.0%} en su ataque ({n['neg']} titular(es) de baja, sanción o duda). Verifica los titulares antes de apostar."
        if backed: good = (n["impact"] > 0) if side == backed else (n["impact"] < 0)
        elif k in ("o15", "o25", "o35", "btts"): good = n["impact"] > 0
        elif k in ("u25", "u35", "nobtts"): good = n["impact"] < 0
        else: continue
        (pro if good else con).append(txt)
    if p < .6: con.append("Probabilidad moderada: es una apuesta arriesgada.")
    return pro, con

def picks(r, F):
    ops = []
    for op in options(r):
        e = op["p"] * op["odds"] - 1 if op["odds"] else None
        if op["p"] >= 0.55 and op["p"] < 0.95 or (e is not None and e >= 0.03): ops.append({**op, "edge": e, "score": e if e is not None else (op["p"] - 0.5) * 0.5})
    out, used = [], set()
    for op in sorted(ops, key=lambda x: -x["score"]):
        g = GROUP[op["kind"]]
        if g in used: continue
        used.add(g); pro, con = why(op, r, F)
        out.append(dict(id=op["kind"], label=op["label"], p=round(op["p"], 4), fair=round(1 / op["p"], 2), odds=op["odds"], edge=None if op["edge"] is None else round(op["edge"], 4),
                        level="Alta" if op["p"] >= .75 else "Media" if op["p"] >= .6 else "Arriesgada", value=bool(op["edge"] is not None and op["edge"] >= .03),
                        variable=op["variable"], pro=pro, con=con))
        if len(out) == 3: break
    return out

# ---------- 8. Fútbol ----------
def football(cfg):
    fin, up = fetch_matches()
    if not fin: print("Sin datos de football-data.org (¿clave?)"); return [], [], [], []
    att, dfn, aH, aA = fit_ratings(fin); idx, names = build_index(fin)
    odds = {c: fetch_odds(s) for c, s in COMPS.items()} if OD_KEY else {}
    gen = NOW.strftime("%Y-%m-%dT%H:%M:%SZ")
    rows, preds, events = [], [], []
    for m in sorted(up, key=lambda x: x["dt"]):
        h, a = m["homeTeam"], m["awayTeam"]; hn, an = h.get("shortName") or h["name"], a.get("shortName") or a["name"]
        nh, na = news_items(hn), news_items(an); ih, ia = nh["impact"], na["impact"]
        lh = aH * att[h["id"]] * (1 + ih) * dfn[a["id"]] / (1 + ia)
        la = aA * att[a["id"]] * (1 + ia) * dfn[h["id"]] / (1 + ih)
        raw = probs(lh, la); eid = f"fd-{m['id']}"
        p = calibrate(raw, cfg["champion"])
        row = dict(id=eid, d=m["dt"].isoformat(), c=LABEL[m["code"]], h=hn, a=an, xg=[round(lh, 2), round(la, 2)],
                   p={k: round(v, 4) for k, v in p.items()}, news=[x["title"] for x in (nh["items"] + na["items"])[:4]], flags=[nh["neg"], na["neg"]], odds={}, modelVersion=cfg["champion"]["version"])
        ev = match_event(odds.get(m["code"], []), h["name"], a["name"])
        if ev:
            b = best_prices(ev)
            for k, key in (("p1", ("h2h", ev["home_team"], None)), ("px", ("h2h", "Draw", None)),
                           ("p2", ("h2h", ev["away_team"], None)), ("o25", ("totals", "Over", 2.5)), ("u25", ("totals", "Under", 2.5))):
                if key in b: row["odds"][k] = dict(o=b[key][0], bk=b[key][1])
        F = dict(h_home=form(idx, h["id"], 5, True), a_away=form(idx, a["id"], 5, False), h_all=form(idx, h["id"], 8), a_all=form(idx, a["id"], 8),
                 h2h=h2h(idx, h["id"], a["id"], names), news=dict(h=nh, a=na))
        row["facts"] = dict(home_home=F["h_home"], away_away=F["a_away"], home_all=F["h_all"], away_all=F["a_all"], h2h=F["h2h"],
                            rating=dict(att_h=round(att[h["id"]], 2), def_h=round(dfn[h["id"]], 2), att_a=round(att[a["id"]], 2), def_a=round(dfn[a["id"]], 2)),
                            newsDetail=dict(home=nh, away=na))
        row["picks"] = picks(row, F)
        rows.append(row)
        events.append(dict(eventId=eid, sport="football", competition=LABEL[m["code"]], home=hn, away=an, kickoff=row["d"], sourceIds=dict(footballData=m["id"])))
        ctx = dict(competition=LABEL[m["code"]], pFav=round(max(raw["p1"], raw["p2"]), 4), newsHome=nh["neg"], newsAway=na["neg"], newsImpactHome=ih, newsImpactAway=ia,
                   xgHome=round(lh, 2), xgAway=round(la, 2), withOdds=bool(row["odds"]))
        for role, mdl, pp in (("champion", cfg["champion"], p), ("shadow", cfg["candidate"], calibrate(raw, cfg["candidate"]) if cfg["candidate"] else None)):
            if not mdl: continue
            rec = dict(predId=f"{eid}|{mdl['version']}|{gen}", eventId=eid, sport="football", competition=LABEL[m["code"]], home=hn, away=an,
                       kickoff=row["d"], modelVersion=mdl["version"], role=role, source="model", generatedAt=gen, context=ctx, variables=mk_vars(pp, lh, la, row["odds"]))
            if role == "champion": rec["picks"] = row["picks"]
            preds.append(rec)
    return rows, preds, events, fin

# ---------- 9. Combinadas ----------
TIERS = [("1 · Segura", .8, 1, 3), ("2 · Sólida", .68, .8, 3), ("3 · Media", .55, .68, 4), ("4 · Atrevida", .42, .55, 4), ("5 · Loca", .3, .42, 5)]
def legs(r):
    p, o, H, A = r["p"], r["odds"], r["h"], r["a"]
    def L(pr, label, var, k=None): return dict(p=pr, label=label, variable=var, odds=o[k]["o"] if k in o else None)
    res = lambda v, t="eq": dict(metric="result_1x2", test=t, value=v)
    return [L(p["p1"], "Gana " + H, res("1"), "p1"), L(p["p2"], "Gana " + A, res("2"), "p2"),
            L(p["p1"] + p["px"], H + " o empate", res(["1", "X"], "in")), L(p["px"] + p["p2"], A + " o empate", res(["X", "2"], "in")),
            L(p["o15"], "Más de 1.5 goles", dict(metric="goals_total", test="over", line=1.5)),
            L(p["o25"], "Más de 2.5 goles", dict(metric="goals_total", test="over", line=2.5), "o25"),
            L(1 - p["o25"], "Menos de 2.5 goles", dict(metric="goals_total", test="under", line=2.5), "u25"),
            L(p["btts"], "Ambos marcan", dict(metric="btts", test="true"))]

def make_combos(rows, gen, version):
    out = []
    for name, lo, hi, k in TIERS:
        c = []
        for r in rows:
            ok = sorted([l for l in legs(r) if lo <= l["p"] < hi], key=lambda l: -l["p"])
            if ok: c.append((r, ok[0]))
        sel = sorted(c, key=lambda x: -x[1]["p"])[:k]
        if len(sel) < 2: continue
        pr = od = 1.0; est = False; L = []
        for r, l in sel:
            o = l["odds"]
            if not o: o = MARGIN / l["p"]; est = True
            pr *= l["p"]; od *= o
            L.append(dict(eventId=r["id"], home=r["h"], away=r["a"], kickoff=r["d"], label=l["label"], p=round(l["p"], 4),
                          odds=round(o, 2), oddsSource="real" if l["odds"] else "estimada", variable=l["variable"]))
        out.append(dict(comboId=f"{gen}|{name}", tier=name, generatedAt=gen, modelVersion=version, prob=round(pr, 5), odds=round(od, 2), estimated=est, legs=L))
    return out

# ---------- 10. Tenis: Challenger 100/125/175 + Grand Slams y grandes torneos (Challenger 50 y 75 y ATP/WTA 250/500 excluidos) ----------
GRAND = ("us open", "wimbledon", "french open", "roland garros", "australian open", "aus open")
MASTERS = ("indian wells", "miami", "monte carlo", "madrid", "italian open", "rome", "canadian open", "toronto", "montreal",
           "cincinnati", "shanghai", "paris masters", "atp finals", "nitto atp")
CH_OK = (100, 125, 175)
def tennis_tier(text):
    t = text.lower().replace("_", " ")
    if any(g in t for g in GRAND): return "Grand Slam"
    if any(m in t for m in MASTERS): return "Masters / Finales"
    if "challenger" in t:
        m = re.search(r"\b(50|75|100|125|175)\b", t)
        if not m: return "Challenger (categoría sin verificar)"
        return f"Challenger {m.group(1)}" if int(m.group(1)) in CH_OK else None
    return None

def tid(a, b, d): return "tn-" + hashlib.sha1(f"{a}|{b}|{d}".encode()).hexdigest()[:12]
def sig(z): return 1 / (1 + math.exp(-z))
def lgt(p): p = min(max(p, 1e-4), 1 - 1e-4); return math.log(p / (1 - p))

def tennis_why(t):
    pro, con = [], []; fav_a = t["pa"] >= .5; p = t["pa"] if fav_a else 1 - t["pa"]; fav, dog = (t["a"], t["b"]) if fav_a else (t["b"], t["a"])
    pro.append(f"Probabilidad del modelo para {fav}: {p:.0%} (cuota justa {1 / p:.2f}).")
    if t.get("mp") is not None: pro.append(f"Probabilidad implícita del mercado sin margen: {(t['mp'] if fav_a else 1 - t['mp']):.0%}.")
    o = t["oa"] if fav_a else t["ob"]
    if o:
        e = p * o - 1; (pro if e > 0 else con).append(f"Cuota @{o:.2f}: {'valor' if e > 0 else 'sin valor'} {e:+.0%}.")
    if t.get("rank_a") and t.get("rank_b"):
        rf, rd = (t["rank_a"], t["rank_b"]) if fav_a else (t["rank_b"], t["rank_a"])
        (pro if rf < rd else con).append(f"Ranking: {fav} nº{int(rf)} frente a {dog} nº{int(rd)}.")
    for k, lab in (("forma_a", t["a"]), ("forma_b", t["b"])):
        if t.get(k): pro.append(f"Forma de {lab}: {t[k]}.")
    if t.get("h2h"): pro.append(f"Cara a cara: {t['h2h']}.")
    if t.get("superficie"): pro.append(f"Superficie: {t['superficie']}.")
    for nm, nws in ((t["a"], t["news"]["a"]), (t["b"], t["news"]["b"])):
        if nws["items"] and nws["impact"] != 0: con.append(f"Noticias de {nm}: impacto estimado {nws['impact']:+.0%} ({nws['neg']} titular(es) de lesión/retirada/duda). Verifica los titulares.")
    tier = t.get("tier", "")
    if tier.startswith("Challenger"): con.append("En Challenger hay más irregularidad y menos datos: los favoritos fallan más que en el circuito principal.")
    if p < .65: con.append("Partido igualado: probabilidad moderada.")
    return pro, con

def tennis(cfg):
    out, cal = [], (cfg["champion"].get("calibration") or {}).get("winner")
    def finish(t):
        t["pa_raw"] = t["pa"]; t["pa"] = round(calp(t["pa"], cal), 4)
        t["news"] = dict(a=news_items(t["a"], "tennis"), b=news_items(t["b"], "tennis"))
        t["pro"], t["con"] = tennis_why(t); return t
    if OD_KEY:
        r = get(f"{OD}/sports/", params=dict(apiKey=OD_KEY))
        act = [s for s in (r.json() if r else []) if s["key"].startswith("tennis_") and s.get("active")]
        keep = [(s, tennis_tier(s["key"] + " " + s["title"])) for s in act]
        print("Tenis incluido:", [(s["key"], t) for s, t in keep if t]); print("Tenis excluido por filtro:", [s["key"] for s, t in keep if not t])
        keep = sorted([x for x in keep if x[1]], key=lambda x: not x[1].startswith("Challenger"))[:MAX_TENNIS]
        for s, tier in keep:
            for ev in fetch_odds(s["key"], "h2h"):
                b = best_prices(ev); oa, ob = b.get(("h2h", ev["home_team"], None)), b.get(("h2h", ev["away_team"], None))
                if not (oa and ob): continue
                z = 1 / oa[0] + 1 / ob[0]
                out.append(finish(dict(id="tn-" + ev["id"], t=s["title"], tier=tier, a=ev["home_team"], b=ev["away_team"], pa=round(1 / oa[0] / z, 4),
                                       oa=oa[0], ob=ob[0], d=ev["commence_time"], src="cuotas reales", mp=round(1 / oa[0] / z, 4), modelVersion=TENNIS_VERSION)))
    if os.path.exists("tennis_manual.csv"):
        for r in csv.DictReader(open("tennis_manual.csv", encoding="utf-8")):
            if (r.get("ejemplo") or "").strip().lower() in ("si", "sí", "yes", "1", "true"): continue
            if not r.get("player_a") or not r.get("rank_a"): continue
            tier = tennis_tier((r.get("torneo") or "") + " " + (r.get("categoria") or ""))
            if not tier:
                print("AVISO: fila de tenis excluida por el filtro (usa «Challenger 100/125/175» o «Grand Slam» en torneo/categoria):", r.get("torneo")); continue
            ra, rb = float(r["rank_a"]), float(r["rank_b"])
            na, nb = news_items(r["player_a"], "tennis"), news_items(r["player_b"], "tennis")
            pa = sig(0.55 * math.log(rb / ra) + 3 * (na["impact"] - nb["impact"])); mp = None   # ranking + ajuste por noticias (solo parte propia)
            if r.get("odds_a") and r.get("odds_b"):
                oa, ob = float(r["odds_a"]), float(r["odds_b"]); z = 1 / oa + 1 / ob; mp = round(1 / oa / z, 4); pa = 0.5 * pa + 0.5 * mp
            else: oa = ob = None
            out.append(finish(dict(id=tid(r["player_a"], r["player_b"], r.get("fecha", "")), t=r.get("torneo", "Challenger"), tier=tier, a=r["player_a"], b=r["player_b"],
                            pa=round(pa, 4), oa=oa, ob=ob, d=r.get("fecha", ""), mp=mp, modelVersion=TENNIS_VERSION, rank_a=ra, rank_b=rb,
                            forma_a=r.get("forma_a"), forma_b=r.get("forma_b"), h2h=r.get("h2h"), superficie=r.get("superficie"),
                            src="manual (ranking" + ("+cuotas)" if oa else ")"), note=r.get("notas", ""))))
    return out

def tennis_records(rows, gen, cfg):
    ev, pr = [], []
    for t in rows:
        ev.append(dict(eventId=t["id"], sport="tennis", competition=t["t"], home=t["a"], away=t["b"], kickoff=t["d"]))
        fav_a = t["pa"] >= .5; p = t["pa"] if fav_a else 1 - t["pa"]
        pk = [dict(id="winner_" + ("a" if fav_a else "b"), label=f"Gana {t['a'] if fav_a else t['b']}", p=round(p, 4), fair=round(1 / p, 2), odds=t["oa"] if fav_a else t["ob"],
                   edge=None if not (t["oa"] if fav_a else t["ob"]) else round(p * (t["oa"] if fav_a else t["ob"]) - 1, 4), level="Alta" if p >= .75 else "Media" if p >= .6 else "Arriesgada",
                   value=bool((t["oa"] if fav_a else t["ob"]) and p * (t["oa"] if fav_a else t["ob"]) - 1 >= .03), variable=dict(metric="winner", test="eq", value="A" if fav_a else "B"), pro=t["pro"], con=t["con"])] if p >= .55 else []
        t["picks"] = pk
        for role, mdl, pa in (("champion", cfg["champion"], t["pa"]), ("shadow", cfg["candidate"], calp(t["pa_raw"], (cfg["candidate"] or {}).get("calibration", {}).get("winner")) if cfg["candidate"] else None)):
            if not mdl: continue
            rec = dict(predId=f"{t['id']}|{mdl['version'] if role == 'shadow' else TENNIS_VERSION}|{gen}", eventId=t["id"], sport="tennis", competition=t["t"], home=t["a"], away=t["b"],
                       kickoff=t["d"], modelVersion=mdl["version"] if role == "shadow" else TENNIS_VERSION, role=role, source="model", generatedAt=gen,
                       context=dict(competition=t["t"], tier=t.get("tier"), pFav=round(max(pa, 1 - pa), 4), withOdds=bool(t.get("oa")), source=t["src"],
                                    newsImpactA=t["news"]["a"]["impact"], newsImpactB=t["news"]["b"]["impact"]),
                       variables=[dict(id="winner", metric="winner", type="binary", test="eq", value="A", p=round(pa, 4), market_p=t.get("mp"))])
            if role == "champion": rec["picks"] = pk
            pr.append(rec)
    return ev, pr

# ---------- 11. Historial inmutable y resultados ----------
def write_history(snap, gen):
    os.makedirs("docs/history", exist_ok=True)
    path = os.path.join("docs/history", gen.replace(":", "") + ".json")
    with open(path, "x", encoding="utf-8") as f: json.dump(snap, f, ensure_ascii=False)   # "x": nunca sobrescribe
    files = sorted(x for x in os.listdir("docs/history") if x.startswith("20") and x.endswith(".json"))
    json.dump({"files": files}, open("docs/history/index.json", "w", encoding="utf-8"))

def update_results(fin):
    path = "docs/results.json"
    try: cur = json.load(open(path, encoding="utf-8"))
    except Exception: cur = {"results": {}}
    for m in fin:
        if (NOW - m["dt"]).days > 45: continue
        sc = m["score"]; ft, ht = sc["fullTime"], sc.get("halfTime") or {}
        cur["results"][f"fd-{m['id']}"] = dict(home=m["homeTeam"]["name"], away=m["awayTeam"]["name"], utc=m["utcDate"],
            ft=[ft["home"], ft["away"]], ht=[ht["home"], ht["away"]] if ht.get("home") is not None else None,
            source="football-data.org", fetchedAt=NOW.strftime("%Y-%m-%dT%H:%M:%SZ"))
    cur["updatedAt"] = NOW.strftime("%Y-%m-%dT%H:%M:%SZ")
    json.dump(cur, open(path, "w", encoding="utf-8"), ensure_ascii=False)

# ---------- 12. Salida web ----------
HERE = os.path.dirname(os.path.abspath(__file__))
HTML = open(os.path.join(HERE, "template.html"), encoding="utf-8").read()
def main():
    import learn
    cfg = load_config(); gen = NOW.strftime("%Y-%m-%dT%H:%M:%SZ")
    try: cfg = learn.run(cfg, NOW)                       # aprendizaje con resultados ya conocidos (antes de predecir)
    except Exception as e: print("AVISO: el aprendizaje automático falló y se omite:", e)
    rows, preds, events, fin = football(cfg)
    ten = tennis(cfg); tev, tpr = tennis_records(ten, gen, cfg)
    combos = make_combos(rows, gen, cfg["champion"]["version"])
    os.makedirs("docs", exist_ok=True)
    if preds or tpr:
        write_history(dict(schemaVersion=1, generatedAt=gen, events=events + tev, predictions=preds + tpr, combos=combos), gen)
    if fin: update_results(fin)
    try: mlog = json.load(open("docs/models/log.json", encoding="utf-8"))
    except Exception: mlog = []
    data = dict(updated=NOW.strftime("%d/%m/%Y %H:%M UTC"), generatedAt=gen, football=rows, tennis=ten, combos=combos,
                margin=MARGIN, modelConfig=cfg, learningLog=mlog[-15:])
    open("docs/data.json", "w", encoding="utf-8").write(json.dumps(data, ensure_ascii=False))
    open("docs/index.html", "w", encoding="utf-8").write(HTML.replace("__DATA__", json.dumps(data, ensure_ascii=False)))
    wd = os.path.join(HERE, "web")
    if os.path.isdir(wd):
        for f in os.listdir(wd):
            if f.endswith(".js"): shutil.copy(os.path.join(wd, f), os.path.join("docs", f))
    print("OK:", len(rows), "partidos,", len(ten), "de tenis,", len(combos), "combinadas")
if __name__ == "__main__": main()
