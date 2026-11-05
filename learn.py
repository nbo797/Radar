#!/usr/bin/env python3
"""Aprendizaje automático con salvaguardas. Se ejecuta al inicio de cada actualización diaria (radar.py).

Ciclo (todo queda registrado en docs/models/log.json y es reversible editando model_config.json):
  1. Con resultados reales ya conocidos mide cómo de bien calibradas están las probabilidades del modelo campeón.
  2. Si una recalibración mejora SIGNIFICATIVAMENTE en el tramo temporal más reciente (ajuste con el 70 % antiguo, test con el 30 % reciente),
     se registra como CANDIDATA y corre en sombra (sus predicciones se guardan pero no se muestran como oficiales).
  3. La candidata solo se promociona a campeona si, con eventos POSTERIORES a su creación (datos independientes), mejora al campeón
     con intervalo de confianza que excluye el empate. Si tras muchos datos no mejora, se descarta.
  Desactivable con "auto_learn": false en model_config.json (entonces solo se propone desde la web, con aprobación manual)."""
import os, json, math, random, datetime as dt
from collections import defaultdict

MIN_N, MIN_TEST, MIN_EFFECT = 100, 30, 0.002      # eventos mínimos por variable, eventos de test y mejora mínima de Brier
MIN_PAIRS, DISCARD_PAIRS = 60, 200                  # pares (evento, variable) para promocionar / descartar una candidata
A_BOUNDS, B_MAX = (0.5, 1.5), 0.5                   # límites de seguridad de la recalibración
SUPPORTED = {"goals_over_0.5", "goals_over_1.5", "goals_over_2.5", "goals_over_3.5", "btts", "winner"}

def _load(path, default):
    try: return json.load(open(path, encoding="utf-8"))
    except Exception: return default

def load_history(root="docs/history"):
    if not os.path.isdir(root): return []
    preds = []
    for f in sorted(os.listdir(root)):
        if f.startswith("20") and f.endswith(".json"): preds += _load(os.path.join(root, f), {}).get("predictions", [])
    return preds

def load_results():
    res = {k: dict(ft=v["ft"]) for k, v in _load("docs/results.json", {}).get("results", {}).items() if v.get("ft") and None not in v["ft"]}
    for r in _load("manual_results.json", {}).get("results", []):          # exportado desde la web; los manuales mandan sobre los de la API
        if r.get("status") in ("confirmed", "corrected") and r.get("values"): res[r["eventId"]] = r["values"]
    return res

def actual(metric, v):
    if not v or v.get("void"): return None
    ft = v.get("ft")
    if metric == "goals_total": return ft[0] + ft[1] if ft and None not in ft else None
    if metric == "btts": return (ft[0] > 0 and ft[1] > 0) if ft and None not in ft else None
    if metric == "winner": return v["winner"] if v.get("winner") in ("A", "B") else None
    return None

def occurred(var, a):
    t = var["test"]
    return a > var["line"] if t == "over" else a < var["line"] if t == "under" else a is True if t == "true" else a is False if t == "false" else a == var.get("value")

def pre_kickoff(preds):
    best = {}
    for p in preds:
        if not p.get("kickoff") or not p["generatedAt"] <= p["kickoff"]: continue          # una predicción posterior al inicio nunca se usa
        k = (p["eventId"], p["modelVersion"], p["role"])
        if k not in best or p["generatedAt"] > best[k]["generatedAt"]: best[k] = p
    return list(best.values())

def build_rows(preds, results):
    rows = []
    for p in pre_kickoff(preds):
        vals = results.get(p["eventId"])
        if vals is None: continue
        for v in p["variables"]:
            if v.get("type") != "binary" or v["id"] not in SUPPORTED: continue
            a = actual(v["metric"], vals)
            if a is None: continue
            rows.append(dict(eventId=p["eventId"], varId=v["id"], version=p["modelVersion"], role=p["role"], kickoff=p["kickoff"], p=v["p"], y=int(occurred(v, a))))
    return rows

sig = lambda z: 1 / (1 + math.exp(-max(-60.0, min(60.0, z))))
def logit(p): p = min(max(p, 1e-4), 1 - 1e-4); return math.log(p / (1 - p))

def fit_platt(rs, lam=1.0):
    a, b = 1.0, 0.0
    for _ in range(50):
        ga, gb, haa, hab, hbb = lam * (a - 1), lam * b, lam, 0.0, lam
        for r in rs:
            z = logit(r["p"]); q = sig(a * z + b); w = q * (1 - q)
            ga += (q - r["y"]) * z; gb += q - r["y"]; haa += w * z * z; hab += w * z; hbb += w
        det = haa * hbb - hab * hab
        if abs(det) < 1e-12: break
        da, db = (hbb * ga - hab * gb) / det, (haa * gb - hab * ga) / det
        da, db = max(-1.0, min(1.0, da)), max(-1.0, min(1.0, db)); a = max(-10.0, min(10.0, a - da)); b = max(-10.0, min(10.0, b - db))   # paso acotado: evita divergencias
        if abs(da) + abs(db) < 1e-9: break
    return a, b

def boot_ci(groups, alpha=0.05, B=600, seed=7):
    """Intervalo bootstrap de la media global remuestreando GRUPOS (eventos), para no tratar como independientes variables del mismo partido."""
    if len(groups) < 2: return None
    rng, ms = random.Random(seed), []
    for _ in range(B):
        s = n = 0
        for _ in groups:
            g = groups[rng.randrange(len(groups))]; s += sum(g); n += len(g)
        ms.append(s / n)
    ms.sort(); return ms[int(B * alpha / 2)], ms[min(B - 1, int(B * (1 - alpha / 2)))]

def compose(old, new):
    old = old or {"a": 1.0, "b": 0.0}
    return {"a": round(new[0] * old["a"], 5), "b": round(new[0] * old["b"] + new[1], 5)}

def propose(rows, champ):
    out = []
    by = defaultdict(list)
    for r in rows:
        if r["role"] == "champion" and r["version"] == champ["version"]: by[r["varId"]].append(r)
    for vid, rs in by.items():
        rs.sort(key=lambda r: r["kickoff"]); n = len(rs)
        if n < MIN_N: continue
        cut = int(n * 0.7); tr, te = rs[:cut], rs[cut:]
        if len(te) < MIN_TEST: continue
        a, b = fit_platt(tr)
        if not (A_BOUNDS[0] <= a <= A_BOUNDS[1] and abs(b) <= B_MAX): continue
        d = [[(sig(a * logit(r["p"]) + b) - r["y"]) ** 2 - (r["p"] - r["y"]) ** 2] for r in te]
        ci, mean = boot_ci(d), sum(x[0] for x in d) / len(d)
        if ci and ci[1] < 0 and -mean >= MIN_EFFECT:
            out.append(dict(varId=vid, n=n, a=a, b=b, improvement=-mean, ci=[-ci[1], -ci[0]], cal=compose((champ.get("calibration") or {}).get(vid), (a, b))))
    return out

def paired(rows, champ_v, cand_v, changed):
    ch = {(r["eventId"], r["varId"]): r for r in rows if r["role"] == "champion" and r["version"] == champ_v and r["varId"] in changed}
    groups = defaultdict(list)
    for r in rows:
        if r["role"] == "shadow" and r["version"] == cand_v:
            c = ch.get((r["eventId"], r["varId"]))
            if c: groups[r["eventId"]].append((r["p"] - r["y"]) ** 2 - (c["p"] - c["y"]) ** 2)
    return list(groups.values())

def run(cfg, now):
    if not cfg.get("auto_learn", True): return cfg
    rows = build_rows(load_history(), load_results()); champ, cand, log = cfg["champion"], cfg.get("candidate"), []
    stamp = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    if cand:
        g = paired(rows, champ["version"], cand["version"], set(cand.get("changed", []))); n = sum(len(x) for x in g)
        if n >= MIN_PAIRS:
            ci = boot_ci(g); mean = sum(sum(x) for x in g) / n
            if ci and ci[1] < 0 and -mean >= MIN_EFFECT:
                cfg["champion"] = {"version": cand["version"], "calibration": cand["calibration"]}; cfg["candidate"] = None
                log.append(dict(at=stamp, action="promocion", version=cand["version"], previous=champ["version"], pares=n, mejoraBrier=round(-mean, 5), ic95=[round(-ci[1], 5), round(-ci[0], 5)],
                                detalle="La candidata mejoró al campeón con datos posteriores a su creación."))
            elif n >= DISCARD_PAIRS:
                cfg["candidate"] = None
                log.append(dict(at=stamp, action="descarte", version=cand["version"], pares=n, mejoraBrier=round(-mean, 5), detalle="Sin mejora demostrada tras suficientes datos independientes."))
    else:
        props = propose(rows, champ)
        if props:
            cal = dict(champ.get("calibration") or {}); cal.update({p["varId"]: p["cal"] for p in props})
            ver = champ["version"].split("+")[0] + "+cal-" + now.strftime("%Y%m%d")
            cfg["candidate"] = dict(version=ver, calibration=cal, createdAt=stamp, changed=[p["varId"] for p in props], reason="auto")
            log.append(dict(at=stamp, action="candidata", version=ver, variables=[dict(var=p["varId"], n=p["n"], a=round(p["a"], 3), b=round(p["b"], 3), mejoraBrierTest=round(p["improvement"], 5), ic95=[round(x, 5) for x in p["ci"]]) for p in props],
                            detalle="Mejora validada en el tramo temporal reciente; pasa a prueba en paralelo (sombra)."))
    if log:
        json.dump(cfg, open("model_config.json", "w", encoding="utf-8"), indent=1, ensure_ascii=False)
        os.makedirs("docs/models", exist_ok=True); cur = _load("docs/models/log.json", [])
        json.dump(cur + log, open("docs/models/log.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        for e in log: print("APRENDIZAJE:", e["action"], e["version"])
    return cfg
