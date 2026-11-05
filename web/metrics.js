/* RadarMetrics: métricas estándar. Binarias: registros {p, y}. Multiclase: {probs, y}. Numéricas: {ae}. */
(function (root) {
  const EPS = 1e-15, clip = p => Math.min(Math.max(p, EPS), 1 - EPS), mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  function binary(rs) {
    const n = rs.length; if (!n) return { n: 0 };
    let tp = 0, fp = 0, fn = 0, tn = 0;
    rs.forEach(r => { const yes = r.p >= 0.5; if (yes && r.y) tp++; else if (yes && !r.y) fp++; else if (!yes && r.y) fn++; else tn++; });
    const base = mean(rs.map(r => r.y)), mk = rs.filter(r => r.market_p != null);
    return { n, accuracy: (tp + tn) / n, precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null,
      brier: mean(rs.map(r => (r.p - r.y) ** 2)), logLoss: mean(rs.map(r => -(r.y ? Math.log(clip(r.p)) : Math.log(clip(1 - r.p))))),
      baseRate: base, brierBase: base * (1 - base),                               // Brier de predecir siempre la tasa base (referencia)
      nMarket: mk.length, brierMarket: mk.length ? mean(mk.map(r => (r.market_p - r.y) ** 2)) : null,
      brierModelOnMarket: mk.length ? mean(mk.map(r => (r.p - r.y) ** 2)) : null, wilson: wilson(tp + tn, n), tp, fp, fn, tn };
  }
  function multiclass(rs) {
    const n = rs.length; if (!n) return { n: 0 };
    const hits = rs.filter(r => Object.keys(r.probs).reduce((a, b) => r.probs[b] > r.probs[a] ? b : a) === r.y).length;
    const mk = rs.filter(r => r.market_p);
    return { n, accuracy: hits / n, brier: mean(rs.map(r => Object.keys(r.probs).reduce((s, c) => s + (r.probs[c] - (c === r.y ? 1 : 0)) ** 2, 0))),
      logLoss: mean(rs.map(r => -Math.log(clip(r.probs[r.y] || 0)))), wilson: wilson(hits, n), nMarket: mk.length,
      brierMarket: mk.length ? mean(mk.map(r => Object.keys(r.probs).reduce((s, c) => s + (r.market_p[c] - (c === r.y ? 1 : 0)) ** 2, 0))) : null,
      brierModelOnMarket: mk.length ? mean(mk.map(r => Object.keys(r.probs).reduce((s, c) => s + (r.probs[c] - (c === r.y ? 1 : 0)) ** 2, 0))) : null };
  }
  const mae = rs => rs.length ? { n: rs.length, mae: mean(rs.map(r => r.ae)) } : { n: 0 };
  function wilson(k, n, z = 1.96) {
    if (!n) return null; const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
    return [(c - m) / d, (c + m) / d];
  }
  function calibration(rs, bins = 10) {
    const B = Array.from({ length: bins }, () => ({ n: 0, sp: 0, sy: 0 }));
    rs.forEach(r => { const i = Math.min(bins - 1, Math.floor(r.p * bins)); B[i].n++; B[i].sp += r.p; B[i].sy += r.y; });
    return B.map((b, i) => ({ from: i / bins, to: (i + 1) / bins, n: b.n, meanP: b.n ? b.sp / b.n : null, freq: b.n ? b.sy / b.n : null }));
  }
  function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  /* Intervalo bootstrap de la media de arr (nivel 1-alpha), semilla fija => reproducible. */
  function bootMean(arr, alpha = 0.05, B = 600, seed = 7) {
    if (arr.length < 2) return null; const r = rng(seed), ms = [];
    for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < arr.length; i++) s += arr[Math.floor(r() * arr.length)]; ms.push(s / arr.length); }
    ms.sort((x, y) => x - y); return [ms[Math.floor(B * alpha / 2)], ms[Math.min(B - 1, Math.floor(B * (1 - alpha / 2)))]];
  }
  const N_SHOW = 30, N_CONCLUDE = 100;
  const sufficiency = n => n >= N_CONCLUDE ? "suficiente" : n >= N_SHOW ? "orientativa (muestra pequeña)" : "insuficiente (no concluyente)";
  const api = { binary, multiclass, mae, wilson, calibration, bootMean, rng, sufficiency, N_SHOW, N_CONCLUDE, mean };
  root.RadarMetrics = api; if (typeof module !== "undefined") module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
