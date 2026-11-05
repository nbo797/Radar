/* RadarVars: qué significa cada variable y cómo se evalúa contra un resultado real.
   Estados: hit (acierto) · miss (error) · unknown (dato desconocido: nunca cuenta como fallo) · void (anulado) · measured (numérica). */
(function (root) {
  const U = { unknown: 1 }, VD = { void: 1 };
  const num = x => (typeof x === "number" && isFinite(x)) ? x : null;
  const pair = a => (a && num(a[0]) !== null && num(a[1]) !== null) ? a : null;
  const sum2 = a => { a = pair(a); return a ? a[0] + a[1] : U; };
  const findP = (v, s) => (v.players || []).find(p => String(p.name).trim().toLowerCase() === String(s || "").trim().toLowerCase());
  const pl = k => (v, s) => { const p = findP(v, s); if (!p) return U; if (p.played === false) return VD; return num(p[k]) === null ? U : p[k]; };
  const sets = v => Array.isArray(v.sets) && v.sets.length ? v.sets : null;
  const noSets = v => v.retired ? VD : (sets(v) ? null : U);        // retirada: las variables de sets/juegos quedan anuladas
  const tb = s => (s[0] === 7 && s[1] === 6) || (s[0] === 6 && s[1] === 7);
  const FOOT = {
    goals_total: v => sum2(v.ft), goals_home: v => pair(v.ft) ? v.ft[0] : U, goals_away: v => pair(v.ft) ? v.ft[1] : U,
    btts: v => pair(v.ft) ? (v.ft[0] > 0 && v.ft[1] > 0) : U,
    result_1x2: v => pair(v.ft) ? (v.ft[0] > v.ft[1] ? "1" : v.ft[0] < v.ft[1] ? "2" : "X") : U,
    ht_goals_total: v => sum2(v.ht), corners_total: v => sum2(v.corners), cards_total: v => sum2(v.cards), shots_on_target_total: v => sum2(v.sot),
    player_goals: pl("goals"), player_assists: pl("assists"), player_shots_on_target: pl("sot"), player_shots: pl("shots"), player_cards: pl("cards")
  };
  const TEN = {
    winner: v => v.winner === "A" || v.winner === "B" ? v.winner : U,
    sets_total: v => noSets(v) || sets(v).length,
    set_score: v => noSets(v) || (sets(v).filter(s => s[0] > s[1]).length + "-" + sets(v).filter(s => s[1] > s[0]).length),
    games_total: v => noSets(v) || sets(v).reduce((a, s) => a + s[0] + s[1], 0),
    first_set_winner: v => noSets(v) || (sets(v)[0][0] > sets(v)[0][1] ? "A" : "B"),
    tiebreaks_total: v => noSets(v) || sets(v).filter(tb).length,
    aces: pl("aces"), double_faults: pl("double_faults")
  };
  const METRICS = { football: FOOT, tennis: TEN };
  function actual(sport, metric, values, subject) {
    if (!values) return U;
    if (values.void) return VD;
    const f = (METRICS[sport] || {})[metric]; if (!f) return U;
    const r = f(values, subject);
    return (r && r.unknown) ? U : (r && r.void) ? VD : (r === null || r === undefined) ? U : r;
  }
  function occurred(v, a) {
    switch (v.test) {
      case "over": return a > v.line; case "under": return a < v.line;
      case "true": return a === true; case "false": return a === false;
      case "eq": return a === v.value; case "in": return v.value.indexOf(a) >= 0;
    }
    return null;
  }
  /* Evalúa una variable de predicción frente a los valores reales de un resultado. */
  function evaluate(variable, sport, values) {
    const a = actual(sport, variable.metric, values, variable.subject);
    if (a === U) return { status: "unknown" };
    if (a === VD) return { status: "void" };
    if (variable.type === "multiclass") {
      const cls = Object.keys(variable.probs), pred = cls.reduce((x, y) => variable.probs[y] > variable.probs[x] ? y : x);
      return { status: pred === String(a) ? "hit" : "miss", actual: a, pred, y: String(a), probs: variable.probs, market_p: variable.market_p };
    }
    if (variable.type === "numeric") return { status: "measured", actual: a, expected: variable.expected, ae: Math.abs(variable.expected - a) };
    const y = occurred(variable, a) ? 1 : 0, yes = variable.p >= 0.5;
    return { status: (yes === (y === 1)) ? "hit" : "miss", actual: a, y, p: variable.p, market_p: variable.market_p };
  }
  const NAMES = {
    goals_total: "Goles totales", btts: "Ambos marcan", result_1x2: "Resultado 1X2", ht_goals_total: "Goles 1ª parte", corners_total: "Córners totales",
    cards_total: "Tarjetas totales", shots_on_target_total: "Tiros a puerta totales", player_goals: "Jugador: goles", player_assists: "Jugador: asistencias",
    player_shots_on_target: "Jugador: tiros a puerta", player_shots: "Jugador: tiros", player_cards: "Jugador: tarjetas", winner: "Ganador", sets_total: "Sets jugados",
    set_score: "Marcador en sets", games_total: "Juegos totales", first_set_winner: "Ganador 1er set", tiebreaks_total: "Tie-breaks", aces: "Aces (jugador)", double_faults: "Dobles faltas (jugador)"
  };
  const api = { METRICS, evaluate, actual, occurred, NAMES, UNKNOWN: U, VOID: VD };
  root.RadarVars = api; if (typeof module !== "undefined") module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
