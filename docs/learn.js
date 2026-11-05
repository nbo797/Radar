/* RadarLearn: análisis de errores históricos, efecto del contexto y propuestas de mejora.
   Nada de aquí cambia un modelo: solo propone. La aprobación es manual y el modelo se activa subiendo model_config.json al repositorio. */
(function (root) {
  const V = root.RadarVars || require("./vars.js"), M = root.RadarMetrics || require("./metrics.js");
  const MIN_PROPOSE = 60, MIN_TEST = 20;
  /* Para cada (evento, versión, rol) se usa la ÚLTIMA predicción generada ANTES del inicio. Las posteriores se descartan (sería hacer trampa). */
  function pickPreKickoff(preds) {
    const best = new Map();
    preds.forEach(p => {
      if (!p.kickoff || !(p.generatedAt <= p.kickoff)) return;                         // comparación ISO UTC
      const k = p.eventId + "|" + p.modelVersion + "|" + p.role, c = best.get(k);
      if (!c || p.generatedAt > c.generatedAt) best.set(k, p);
    });
    return [...best.values()];
  }
  const favBucket = x => x == null ? "?" : x < 0.45 ? "favorito <45%" : x < 0.6 ? "favorito 45-60%" : "favorito >60%";
  /* Filas planas evaluadas. opts.onlyConfirmed (por defecto true): ignora resultados de API sin confirmar. */
  function buildRows(preds, results, opts = {}) {
    const onlyConfirmed = opts.onlyConfirmed !== false, R = new Map(results.map(r => [r.eventId, r])), rows = [];
    pickPreKickoff(preds).forEach(p => {
      const r = R.get(p.eventId); if (!r || (onlyConfirmed && r.status === "unconfirmed")) return;
      const c = p.context || {}, news = (c.newsHome || 0) + (c.newsAway || 0) > 0 ? "con noticias de bajas" : "sin noticias de bajas";
      p.variables.forEach(v => {
        const e = V.evaluate(v, p.sport, r.values);
        rows.push({ ...e, predId: p.predId, eventId: p.eventId, sport: p.sport, version: p.modelVersion, role: p.role, source: p.source, kickoff: p.kickoff,
          varId: v.id, type: v.type, competition: p.competition, fav: favBucket(c.pFav), news: p.sport === "football" ? news : "n/a", provisional: r.status === "unconfirmed" });
      });
    });
    return rows;
  }
  const group = (rows, f) => rows.reduce((m, r) => { const k = f(r); (m[k] = m[k] || []).push(r); return m; }, {});
  const counts = rows => ({ hit: rows.filter(r => r.status === "hit").length, miss: rows.filter(r => r.status === "miss").length,
    unknown: rows.filter(r => r.status === "unknown").length, void: rows.filter(r => r.status === "void").length });
  function summarize(rows) {
    const out = [];
    Object.entries(group(rows, r => r.sport + "|" + r.varId + "|" + r.version + "|" + r.role)).forEach(([k, rs]) => {
      const [sport, varId, version, role] = k.split("|"), t = rs[0].type, ok = rs.filter(r => ["hit", "miss", "measured"].includes(r.status)), c = counts(rs);
      let m = {}; if (t === "binary") m = M.binary(ok.map(r => ({ p: r.p, y: r.y, market_p: r.market_p })));
      else if (t === "multiclass") m = M.multiclass(ok.map(r => ({ probs: r.probs, y: r.y, market_p: r.market_p }))); else m = M.mae(ok);
      out.push({ sport, varId, version, role, type: t, ...c, m, suficiencia: M.sufficiency(ok.length) });
    });
    return out.sort((a, b) => (b.m.n || 0) - (a.m.n || 0));
  }
  /* Efecto del contexto: sesgo (frecuencia real − probabilidad media) por grupo, con intervalo bootstrap corregido por nº de comparaciones (Bonferroni). Exploratorio. */
  function contextEffects(rows) {
    const bin = rows.filter(r => r.type === "binary" && (r.status === "hit" || r.status === "miss") && r.role !== "shadow"), res = [], tests = [];
    Object.entries(group(bin, r => r.sport + "|" + r.varId)).forEach(([k, rs]) => {
      if (rs.length < MIN_PROPOSE) return;
      [["competition", r => r.competition], ["favorito", r => r.fav], ["noticias", r => r.news]].forEach(([feat, f]) => {
        Object.entries(group(rs, f)).forEach(([g, gr]) => { if (gr.length >= 15) tests.push({ k, feat, g, gr }); });
      });
    });
    const alpha = tests.length ? 0.05 / tests.length : 0.05;
    tests.forEach(t => {
      const d = t.gr.map(r => r.y - r.p), ci = M.bootMean(d, alpha);
      res.push({ variable: t.k, feature: t.feat, group: t.g, n: t.gr.length, bias: M.mean(d), ci, senal: !!ci && (ci[0] > 0 || ci[1] < 0), comparaciones: tests.length, exploratorio: true });
    });
    return res.sort((a, b) => Math.abs(b.bias) - Math.abs(a.bias));
  }
  const sig = z => 1 / (1 + Math.exp(-z)), logit = p => { p = Math.min(Math.max(p, 1e-4), 1 - 1e-4); return Math.log(p / (1 - p)); };
  /* Calibración de Platt: q = sigmoid(a·logit(p)+b), Newton con ridge hacia (1,0). */
  function fitPlatt(rs, lam = 1) {
    let a = 1, b = 0;
    for (let it = 0; it < 50; it++) {
      let ga = lam * (a - 1), gb = lam * b, haa = lam, hab = 0, hbb = lam;
      rs.forEach(r => { const z = logit(r.p), q = sig(a * z + b), w = q * (1 - q); ga += (q - r.y) * z; gb += (q - r.y); haa += w * z * z; hab += w * z; hbb += w; });
      const det = haa * hbb - hab * hab; if (Math.abs(det) < 1e-12) break;
      const da = (hbb * ga - hab * gb) / det, db = (haa * gb - hab * ga) / det; a -= da; b -= db; if (Math.abs(da) + Math.abs(db) < 1e-9) break;
    }
    return { a, b };
  }
  /* Propuestas de recalibración por variable binaria, con validación TEMPORAL: se ajusta con el 70 % más antiguo y se evalúa en el 30 % más reciente. */
  function proposeCalibrations(rows) {
    const out = [], bin = rows.filter(r => r.type === "binary" && (r.status === "hit" || r.status === "miss") && r.role === "champion");
    Object.entries(group(bin, r => r.sport + "|" + r.varId + "|" + r.version)).forEach(([k, rs]) => {
      const [sport, varId, version] = k.split("|"); rs = rs.slice().sort((x, y) => x.kickoff < y.kickoff ? -1 : 1);
      if (rs.length < MIN_PROPOSE) { out.push({ varId, sport, version, n: rs.length, estado: "sin propuesta: faltan datos (mínimo " + MIN_PROPOSE + ")", validated: false }); return; }
      const cut = Math.floor(rs.length * 0.7), tr = rs.slice(0, cut), te = rs.slice(cut);
      if (te.length < MIN_TEST) { out.push({ varId, sport, version, n: rs.length, estado: "sin propuesta: test temporal demasiado pequeño", validated: false }); return; }
      const par = fitPlatt(tr), d = te.map(r => (sig(par.a * logit(r.p) + par.b) - r.y) ** 2 - (r.p - r.y) ** 2), ci = M.bootMean(d), imp = -M.mean(d);   // imp>0 => mejora
      const validated = !!ci && ci[1] < 0;
      out.push({ id: "cal|" + varId + "|" + version + "|" + rs.length, kind: "calibration", varId, sport, version, n: rs.length, nTrain: tr.length, nTest: te.length, params: par,
        brierBase: M.mean(te.map(r => (r.p - r.y) ** 2)), improvement: imp, ci: ci && [-ci[1], -ci[0]], validated,
        estado: validated ? "validada temporalmente (mejora significativa en el bloque más reciente)" : "exploratoria: la mejora no es estadísticamente distinguible del azar" });
    });
    return out;
  }
  /* Comparación entre versiones/roles en las mismas variables binarias. Pareada campeón vs sombra cuando comparten evento y variable. */
  function compareVersions(rows) {
    const bin = rows.filter(r => r.type === "binary" && (r.status === "hit" || r.status === "miss")), vs = [];
    Object.entries(group(bin, r => r.version + "|" + r.role)).forEach(([k, rs]) => { const [version, role] = k.split("|"); vs.push({ version, role, ...M.binary(rs.map(r => ({ p: r.p, y: r.y }))) }); });
    const ch = new Map(bin.filter(r => r.role === "champion").map(r => [r.eventId + "|" + r.varId, r])), pairs = {};
    bin.filter(r => r.role === "shadow").forEach(s => { const c = ch.get(s.eventId + "|" + s.varId); if (c) (pairs[s.version] = pairs[s.version] || []).push((s.p - s.y) ** 2 - (c.p - c.y) ** 2); });
    const paired = Object.entries(pairs).map(([version, d]) => ({ version, n: d.length, meanDiffBrier: M.mean(d), ci: M.bootMean(d), mejor: !!M.bootMean(d) && M.bootMean(d)[1] < 0 }));
    return { versions: vs, paired };
  }
  function buildConfig(current, champion, candidate) {
    return { champion: champion || current.champion, candidate: candidate === undefined ? current.candidate : candidate };
  }

  /* Picks recomendados (los que la app propone con su razonamiento): se evalúan contra el resultado real. */
  function pickRows(preds, results, opts = {}) {
    const onlyConfirmed = opts.onlyConfirmed !== false, R = new Map(results.map(r => [r.eventId, r])), rows = [];
    pickPreKickoff(preds).filter(p => p.role === "champion" && p.picks && p.picks.length).forEach(p => {
      const r = R.get(p.eventId); if (!r || (onlyConfirmed && r.status === "unconfirmed")) return;
      p.picks.forEach(k => { const e = V.evaluate({ ...k.variable, type: "binary", p: k.p }, p.sport, r.values);
        rows.push({ eventId: p.eventId, sport: p.sport, home: p.home, away: p.away, kickoff: p.kickoff, label: k.label, level: k.level, value: !!k.value, p: k.p, odds: k.odds || null, status: e.status, y: e.y, provisional: r.status === "unconfirmed" }); });
    });
    return rows;
  }
  function pickSummary(rows) {
    const res = rows.filter(r => r.status === "hit" || r.status === "miss"), one = rs => {
      const n = rs.length, w = rs.filter(r => r.y === 1).length, wo = rs.filter(r => r.odds);
      return { n, wins: w, rate: n ? w / n : null, meanP: n ? M.mean(rs.map(r => r.p)) : null, brier: n ? M.mean(rs.map(r => (r.p - r.y) ** 2)) : null, wilson: M.wilson(w, n),
        nOdds: wo.length, roi: wo.length ? M.mean(wo.map(r => r.y ? r.odds - 1 : -1)) : null };
    };
    const lv = {}; ["Alta", "Media", "Arriesgada"].forEach(k => { lv[k] = one(res.filter(r => r.level === k)); });
    return { overall: one(res), byLevel: lv, value: one(res.filter(r => r.value)), pendingOrUnknown: rows.length - res.length };
  }
  const api = { pickRows, pickSummary, pickPreKickoff, buildRows, summarize, contextEffects, fitPlatt, proposeCalibrations, compareVersions, buildConfig, counts, MIN_PROPOSE };
  root.RadarLearn = api; if (typeof module !== "undefined") module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
