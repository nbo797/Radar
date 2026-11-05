/* RadarUI: Historial de análisis · Evaluación de eventos · Centro de aprendizaje. Usa db.js, vars.js, metrics.js y learn.js. */
(function (root) {
  const DB = root.RadarDB, V = root.RadarVars, M = root.RadarMetrics, L = root.RadarLearn, $ = s => document.querySelector(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pc = x => x == null ? "—" : (x * 100).toFixed(1) + "%", f3 = x => x == null ? "—" : x.toFixed(3), dtf = s => { try { return new Date(s).toLocaleString("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); } catch (e) { return s; } };
  const num = s => { s = String(s == null ? "" : s).trim().replace(",", "."); return s === "" || isNaN(+s) ? null : +s; };
  const ST = { hit: '<span class="st hit">✓ acierto</span>', miss: '<span class="st miss">✗ error</span>', unknown: '<span class="st unk">? desconocido</span>', void: '<span class="st void">– anulado</span>', measured: '<span class="st meas">≈ medido</span>' };
  const BADGE = { none: '<span class="chip none">sin resultado</span>', unconfirmed: '<span class="chip warn">API · sin confirmar</span>', confirmed: '<span class="chip ok">confirmado</span>', corrected: '<span class="chip pend">corregido</span>' };
  let inclApi = true, D, S = { ev: [], pr: [], rs: [], cb: [], md: [], pp: [] }, filt = { sport: "", ver: "", q: "", pend: true }, learnVar = "";
  const SUPPORTED = ["goals_over_0.5", "goals_over_1.5", "goals_over_2.5", "goals_over_3.5", "btts"];

  async function reload() {
    S.ev = await DB.all("events"); S.pr = await DB.all("predictions"); S.rs = await DB.all("results"); S.cb = await DB.all("combos"); S.md = await DB.all("models"); S.pp = await DB.all("proposals");
    S.ev.sort((a, b) => a.kickoff < b.kickoff ? 1 : -1);
  }
  const rsOf = id => S.rs.find(r => r.eventId === id);
  const msg = (t, ok) => { const e = $("#msg"); e.textContent = t; e.className = "msgbox " + (ok === false ? "bad" : "ok"); e.hidden = !t; if (t) setTimeout(() => { e.hidden = true; }, 9000); };

  // ---------- sincronización con el historial inmutable del repositorio ----------
  async function sync() {
    const st = $("#sync-st"); st.textContent = "Sincronizando…"; let ne = 0, np = 0, nc = 0, nr = 0;
    try {
      const idx = await (await fetch("history/index.json", { cache: "no-store" })).json(), done = (await DB.getMeta("syncedFiles")) || [];
      for (const f of idx.files) {
        if (done.includes(f)) continue; const j = await (await fetch("history/" + f, { cache: "no-store" })).json();
        for (const e of j.events || []) if (await DB.add("events", e)) ne++;
        for (const p of j.predictions || []) if (await DB.add("predictions", p)) np++;
        for (const c of j.combos || []) if (await DB.add("combos", c)) nc++;
        done.push(f);
      }
      await DB.setMeta("syncedFiles", done);
      const r = await fetch("results.json", { cache: "no-store" }); if (r.ok) { const j = await r.json(); for (const [id, x] of Object.entries(j.results || {})) { const c = await DB.get("results", id); if (!c) { await DB.put("results", { eventId: id, source: "api", status: "unconfirmed", values: { ft: x.ft, ht: x.ht }, updatedAt: x.fetchedAt, sourceName: x.source }); nr++; } } }
      st.textContent = `Sincronizado: +${ne} eventos, +${np} predicciones, +${nc} combinadas, +${nr} resultados de API (sin confirmar).`;
    } catch (e) { st.textContent = "No se pudo sincronizar (¿aún no hay historial publicado?): " + e.message; }
    await reload(); renderAll();
  }

  // ---------- copia de seguridad ----------
  async function doExport() { const j = await DB.exportAll(); DB.download("radar-copia-" + new Date().toISOString().slice(0, 10) + ".json", j); await DB.setMeta("lastExport", new Date().toISOString()); msg("Copia exportada. Guárdala fuera del navegador (nube/disco)."); renderBanner(); }
  async function doImport(file) {
    try {
      const j = JSON.parse(await file.text()), pv = await DB.previewImport(j);
      const txt = Object.entries(pv).filter(([, v]) => v.nuevos || v.conflictos).map(([k, v]) => `${k}: ${v.nuevos} nuevos, ${v.conflictos} en conflicto`).join("\n") || "Nada nuevo que importar.";
      if (!confirm("Vista previa de la importación (no se borra nada):\n\n" + txt + "\n\n¿Fusionar?")) return;
      let over = false;
      if (pv.results.conflictos && confirm("Hay " + pv.results.conflictos + " resultados distintos de los actuales.\nAceptar = sustituir por los importados SOLO si son más recientes (el cambio queda registrado).\nCancelar = conservar los actuales.")) over = true;
      if (over) await doExport();                                         // copia automática antes de sobrescribir
      const s = await DB.applyImport(j, { overwriteResults: over }); msg(`Importado: ${s.añadidos} añadidos, ${s.sobrescritos} sobrescritos, ${s.conservados} conservados.`);
    } catch (e) { msg("Importación cancelada: " + e.message, false); }
    await reload(); renderAll();
  }
  async function renderBanner() {
    const last = await DB.getMeta("lastExport"), has = S.rs.length || S.pp.length, days = last ? (Date.now() - new Date(last)) / 864e5 : null;
    const w = !has ? "" : (days == null ? "Aún no has exportado una copia. Tus resultados y evaluaciones solo existen en este navegador." : days > 7 ? `Última copia hace ${Math.floor(days)} días.` : "");
    $("#banner").innerHTML = w ? `<div class="msgbox bad">${w} <button id="b-exp">Exportar ahora</button></div>` : ""; const b = $("#b-exp"); if (b) b.onclick = doExport;
  }

  // ---------- 1. HISTORIAL ----------
  function varLine(v) {
    const n = V.NAMES[v.metric] || v.metric, sub = v.subject ? " · " + esc(v.subject) : "", cond = v.test === "over" ? " > " + v.line : v.test === "under" ? " < " + v.line : v.test === "eq" ? " = " + esc(v.value) : "";
    if (v.type === "multiclass") return `<tr><td>${n}</td><td>${Object.entries(v.probs).map(([k, p]) => k + " " + pc(p)).join(" · ")}</td><td>${v.market_p ? Object.entries(v.market_p).map(([k, p]) => k + " " + pc(p)).join(" · ") : "—"}</td></tr>`;
    if (v.type === "numeric") return `<tr><td>${n} (esperado)</td><td>${v.expected}</td><td>—</td></tr>`;
    return `<tr><td>${n}${sub}${cond}</td><td>${pc(v.p)}</td><td>${v.market_p != null ? pc(v.market_p) : "—"}</td></tr>`;
  }
  function comboStatus(c) {
    let miss = 0, hit = 0, other = 0, prov = false;
    c.legs.forEach(l => { const r = rsOf(l.eventId); if (!r) { other++; return; } if (r.status === "unconfirmed") prov = true; const e = V.evaluate({ ...l.variable, type: "binary", p: l.p }, "football", r.values); if (e.status === "hit" || e.status === "miss") (e.y ? hit++ : miss++); else other++; });
    return { s: miss ? "miss" : (hit === c.legs.length ? "hit" : "pending"), hit, miss, other, prov };
  }
  function picksBlock(p) {
    if (!p.picks || !p.picks.length) return "";
    return `<div class="m" style="margin-top:6px"><b>Picks recomendados guardados</b></div>` + p.picks.map(k => `<details><summary>${esc(k.label)} · ${esc(k.level)} · ${pc(k.p)}${k.odds ? " · @" + k.odds.toFixed(2) : ""}</summary><ul>${(k.pro || []).map(x => "<li>+ " + esc(x) + "</li>").join("")}${(k.con || []).map(x => "<li>− " + esc(x) + "</li>").join("")}</ul></details>`).join("");
  }
  function renderHistory() {
    const vers = [...new Set(S.pr.map(p => p.modelVersion))];
    let list = S.ev.filter(e => (!filt.sport || e.sport === filt.sport) && (!filt.q || (e.home + " " + e.away + " " + e.competition).toLowerCase().includes(filt.q.toLowerCase())) && (!filt.ver || S.pr.some(p => p.eventId === e.eventId && p.modelVersion === filt.ver)));
    const shown = list.slice(0, 60);
    $("#h-list").innerHTML = `<div class="m">${list.length} eventos · ${S.pr.length} predicciones guardadas (inmutables)</div>` + (shown.map(e => {
      const ps = S.pr.filter(p => p.eventId === e.eventId).sort((a, b) => a.generatedAt < b.generatedAt ? 1 : -1), r = rsOf(e.eventId);
      return `<div class="card"><div class="t"><b>${esc(e.home)} – ${esc(e.away)}</b><span class="m">${e.sport === "football" ? "Fútbol" : "Tenis"} · ${esc(e.competition)} · ${dtf(e.kickoff)} · ${BADGE[r ? r.status : "none"]}</span></div>` +
        ps.map(p => `<details><summary>${esc(p.modelVersion)} · ${esc(p.role)} · generada ${dtf(p.generatedAt)}${p.generatedAt > p.kickoff ? ' <span class="st warn">posterior al inicio · no se usa para evaluar</span>' : ""}</summary>
          <table><tr><th>Variable</th><th>Prob. modelo</th><th>Prob. mercado</th></tr>${p.variables.map(varLine).join("")}</table>
          ${picksBlock(p)}${p.context ? `<div class="m">Contexto guardado: ${esc(JSON.stringify(p.context))}</div>` : ""}</details>`).join("") + `</div>`;
    }).join("") || `<div class="empty">Sin eventos. Pulsa «Sincronizar» (tras la primera ejecución de la Action) o añade una predicción manual.</div>`) + (list.length > 60 ? `<div class="m">Mostrando 60 de ${list.length}; usa los filtros.</div>` : "");
    $("#h-ver").innerHTML = `<option value="">Todas las versiones</option>` + vers.map(v => `<option ${v === filt.ver ? "selected" : ""}>${esc(v)}</option>`).join("");
    const cs = S.cb.slice().sort((a, b) => a.generatedAt < b.generatedAt ? 1 : -1).slice(0, 40);
    $("#h-combos").innerHTML = cs.map(c => { const st = comboStatus(c); return `<div class="card"><div class="t"><b>${esc(c.tier)}</b><span class="m">${dtf(c.generatedAt)} · prob. ${pc(c.prob)} · cuota ${c.odds}${c.estimated ? "*" : ""} · ${st.s === "hit" ? '<span class="st hit">acertada</span>' : st.s === "miss" ? '<span class="st miss">fallada</span>' : '<span class="st unk">pendiente</span>'}${st.prov ? " (provisional)" : ""}</span></div>
      <ul>${c.legs.map(l => { const r = rsOf(l.eventId), e = r ? V.evaluate({ ...l.variable, type: "binary", p: l.p }, "football", r.values) : null; return `<li>${esc(l.home)} – ${esc(l.away)}: <b>${esc(l.label)}</b> · ${pc(l.p)} · ${e && (e.status === "hit" || e.status === "miss") ? (e.y ? '<span class="st hit">✓</span>' : '<span class="st miss">✗</span>') : e ? ST[e.status] : '<span class="st unk">pendiente</span>'}</li>`; }).join("")}</ul></div>`; }).join("") || `<div class="empty">Aún no hay combinadas guardadas.</div>`;
    const done = S.cb.map(comboStatus).filter(x => x.s !== "pending" && !x.prov), tiers = {};
    S.cb.forEach(c => { const st = comboStatus(c); if (st.s !== "pending" && !st.prov) { (tiers[c.tier] = tiers[c.tier] || { n: 0, h: 0, p: 0 }); tiers[c.tier].n++; tiers[c.tier].h += st.s === "hit" ? 1 : 0; tiers[c.tier].p += c.prob; } });
    $("#h-cstat").innerHTML = Object.keys(tiers).length ? `<table><tr><th>Nivel</th><th>Resueltas</th><th>Acertadas</th><th>% real</th><th>% medio previsto</th></tr>${Object.entries(tiers).sort().map(([t, x]) => `<tr><td>${esc(t)}</td><td>${x.n}</td><td>${x.h}</td><td>${pc(x.h / x.n)}</td><td>${pc(x.p / x.n)}</td></tr>`).join("")}</table><div class="m">Con pocas combinadas resueltas, el % real no es concluyente.</div>` : "";
  }

  // ---------- predicción manual (solo ANTES del inicio) ----------
  const PRE = [
    { k: "goals_total", s: "football", l: "Goles totales (más de…)", metric: "goals_total", test: "over", line: 2.5 }, { k: "btts", s: "football", l: "Ambos marcan (sí)", metric: "btts", test: "true" },
    { k: "corners", s: "football", l: "Córners totales (más de…)", metric: "corners_total", test: "over", line: 9.5 }, { k: "cards", s: "football", l: "Tarjetas totales (más de…)", metric: "cards_total", test: "over", line: 4.5 },
    { k: "sot", s: "football", l: "Tiros a puerta totales (más de…)", metric: "shots_on_target_total", test: "over", line: 8.5 }, { k: "pgoal", s: "football", l: "Jugador marca", metric: "player_goals", test: "over", line: .5, subj: 1 },
    { k: "passist", s: "football", l: "Jugador asiste", metric: "player_assists", test: "over", line: .5, subj: 1 }, { k: "psot", s: "football", l: "Jugador: tiros a puerta (más de…)", metric: "player_shots_on_target", test: "over", line: 1.5, subj: 1 },
    { k: "pcard", s: "football", l: "Jugador: tarjeta", metric: "player_cards", test: "over", line: .5, subj: 1 },
    { k: "winner", s: "tennis", l: "Ganador (jugador A/B)", metric: "winner", test: "eq", side: 1 }, { k: "sets", s: "tennis", l: "Sets jugados (más de…)", metric: "sets_total", test: "over", line: 2.5 },
    { k: "games", s: "tennis", l: "Juegos totales (más de…)", metric: "games_total", test: "over", line: 22.5 }, { k: "fset", s: "tennis", l: "Ganador del 1er set (A/B)", metric: "first_set_winner", test: "eq", side: 1 },
    { k: "tbk", s: "tennis", l: "Tie-breaks (más de…)", metric: "tiebreaks_total", test: "over", line: .5 }, { k: "ace", s: "tennis", l: "Aces de un jugador (más de…)", metric: "aces", test: "over", line: 5.5, subj: 1 }
  ];
  function renderManual() {
    const evs = S.ev.filter(e => e.kickoff > new Date().toISOString());
    $("#m-form").innerHTML = `<div class="grid2"><label>Evento<select id="m-ev"><option value="">— evento nuevo —</option>${evs.map(e => `<option value="${esc(e.eventId)}">${esc(e.home)} – ${esc(e.away)} (${dtf(e.kickoff)})</option>`).join("")}</select></label>
      <label>Variable<select id="m-pre">${PRE.map(p => `<option value="${p.k}">${p.s === "football" ? "Fútbol" : "Tenis"} · ${p.l}</option>`).join("")}</select></label></div>
      <div class="grid2" id="m-new"><label>Deporte<select id="m-sp"><option value="football">Fútbol</option><option value="tennis">Tenis</option></select></label><label>Competición<input id="m-comp"></label>
      <label>Local / jugador A<input id="m-h"></label><label>Visitante / jugador B<input id="m-a"></label><label>Inicio (fecha y hora)<input id="m-ko" type="datetime-local"></label></div>
      <div class="grid2"><label>Línea<input id="m-line"></label><label id="m-sbj-w">Jugador / sujeto<input id="m-sbj"></label><label id="m-side-w">Lado<select id="m-side"><option>A</option><option>B</option></select></label><label>Probabilidad (%)<input id="m-p" placeholder="ej. 55"></label></div>
      <button id="m-save">Guardar predicción manual</button><div class="m">Se guarda como fuente «manual» y no se puede modificar después. Solo se admite antes del inicio del evento.</div>`;
    const upd = () => { const p = PRE.find(x => x.k === $("#m-pre").value), ex = $("#m-ev").value; $("#m-new").hidden = !!ex; $("#m-line").value = p.line != null ? p.line : ""; $("#m-line").disabled = p.line == null; $("#m-sbj-w").hidden = !p.subj; $("#m-side-w").hidden = !p.side; if (!ex) $("#m-sp").value = p.s; };
    $("#m-pre").onchange = upd; $("#m-ev").onchange = upd; upd();
    $("#m-save").onclick = async () => {
      try {
        const p = PRE.find(x => x.k === $("#m-pre").value), prob = num($("#m-p").value), now = new Date().toISOString(); if (prob == null || prob <= 0 || prob >= 100) throw new Error("La probabilidad debe estar entre 0 y 100 (sin incluirlos)");
        let e = S.ev.find(x => x.eventId === $("#m-ev").value);
        if (!e) { const ko = $("#m-ko").value; if (!ko || !$("#m-h").value || !$("#m-a").value) throw new Error("Rellena local, visitante y fecha de inicio"); e = { eventId: "mn-" + Date.now().toString(36), sport: $("#m-sp").value, competition: $("#m-comp").value || "Manual", home: $("#m-h").value, away: $("#m-a").value, kickoff: new Date(ko).toISOString() }; if (e.sport !== p.s) throw new Error("La variable elegida no corresponde a ese deporte"); }
        if (now >= e.kickoff) throw new Error("El evento ya ha empezado: no se aceptan predicciones posteriores (invalidaría la evaluación)");
        const line = p.line != null ? num($("#m-line").value) : null; if (p.line != null && line == null) throw new Error("Indica la línea");
        const subj = p.subj ? $("#m-sbj").value.trim() : null; if (p.subj && !subj) throw new Error("Indica el jugador");
        const variable = { id: p.metric + (subj ? "|" + subj : "") + (line != null ? "|" + line : "") + (p.side ? "|" + $("#m-side").value : ""), metric: p.metric, type: "binary", test: p.test, p: prob / 100, market_p: null };
        if (line != null) variable.line = line; if (p.test === "eq") variable.value = $("#m-side").value; if (subj) variable.subject = subj;
        await DB.add("events", e);
        await DB.add("predictions", { predId: `${e.eventId}|manual|${now}|${variable.id}`, eventId: e.eventId, sport: e.sport, competition: e.competition, home: e.home, away: e.away, kickoff: e.kickoff, modelVersion: "manual", role: "manual", source: "manual", generatedAt: now, context: { competition: e.competition }, variables: [variable] });
        msg("Predicción manual guardada."); await reload(); renderAll();
      } catch (err) { msg(err.message, false); }
    };
  }

  // ---------- 2. EVALUACIÓN ----------
  function evalTable(e) {
    const r = rsOf(e.eventId); if (!r) return ""; const ps = L.pickPreKickoff(S.pr.filter(p => p.eventId === e.eventId));
    if (!ps.length) return `<div class="m">Sin predicciones generadas antes del inicio: nada que evaluar.</div>`;
    return ps.map(p => `<table><caption>${esc(p.modelVersion)} · ${esc(p.role)} ${r.status === "unconfirmed" ? "· PROVISIONAL (resultado de API sin confirmar)" : ""}</caption><tr><th>Variable</th><th>Predicción</th><th>Real</th><th>Estado</th></tr>${p.variables.map(v => {
      const x = V.evaluate(v, p.sport, r.values), pr = v.type === "multiclass" ? Object.entries(v.probs).map(([k, q]) => k + " " + pc(q)).join(" · ") : v.type === "numeric" ? v.expected : pc(v.p);
      const act = x.actual === undefined ? "—" : typeof x.actual === "boolean" ? (x.actual ? "sí" : "no") : esc(x.actual), nm = (V.NAMES[v.metric] || v.metric) + (v.subject ? " · " + esc(v.subject) : "") + (v.test === "over" ? " > " + v.line : v.test === "under" ? " < " + v.line : v.test === "eq" ? " = " + esc(v.value) : "");
      return `<tr><td>${nm}</td><td>${pr}</td><td>${act}</td><td>${ST[x.status]}${x.ae != null ? " (error " + x.ae.toFixed(2) + ")" : ""}</td></tr>`;
    }).join("")}</table>` + (p.picks && p.picks.length ? `<table><caption>Picks recomendados</caption><tr><th>Pick</th><th>Nivel</th><th>Prob.</th><th>Resultado</th></tr>${p.picks.map(k => { const x = V.evaluate({ ...k.variable, type: "binary", p: k.p }, p.sport, r.values); return `<tr><td>${esc(k.label)}</td><td>${esc(k.level)}</td><td>${pc(k.p)}</td><td>${x.status === "hit" || x.status === "miss" ? (x.y ? '<span class="pill hit">acertado</span>' : '<span class="pill miss">fallado</span>') : ST[x.status]}</td></tr>`; }).join("")}</table>` : "")).join("");
  }
  function formHtml(e, r) {
    const v = (r && r.values) || {}, pair = (k, i) => v[k] && v[k][i] != null ? v[k][i] : "";
    if (e.sport === "football") {
      const subj = [...new Set(S.pr.filter(p => p.eventId === e.eventId).flatMap(p => p.variables.filter(x => x.subject).map(x => x.subject)))], pls = (v.players || subj.map(n => ({ name: n })));
      const row = p => `<tr class="prow"><td><input class="pn" value="${esc(p.name || "")}"></td><td><input type="checkbox" class="pp" ${p.played === false ? "" : "checked"}></td>${["goals", "assists", "sot", "shots", "cards"].map(k => `<td><input class="pk" data-k="${k}" value="${p[k] != null ? p[k] : ""}"></td>`).join("")}</tr>`;
      return `<div class="grid2"><label>Goles final (local – visitante)<span><input id="f-ft0" value="${pair("ft", 0)}"> – <input id="f-ft1" value="${pair("ft", 1)}"></span></label>
        <label>Goles descanso<span><input id="f-ht0" value="${pair("ht", 0)}"> – <input id="f-ht1" value="${pair("ht", 1)}"></span></label>
        <label>Córners<span><input id="f-co0" value="${pair("corners", 0)}"> – <input id="f-co1" value="${pair("corners", 1)}"></span></label>
        <label>Tarjetas (amarillas+rojas)<span><input id="f-ca0" value="${pair("cards", 0)}"> – <input id="f-ca1" value="${pair("cards", 1)}"></span></label>
        <label>Tiros a puerta<span><input id="f-so0" value="${pair("sot", 0)}"> – <input id="f-so1" value="${pair("sot", 1)}"></span></label></div>
        <table id="f-pl"><tr><th>Jugador</th><th>Jugó</th><th>Goles</th><th>Asist.</th><th>T. puerta</th><th>Tiros</th><th>Tarj.</th></tr>${pls.map(row).join("")}</table><button class="mini" id="f-addp">+ jugador</button>
        <div class="m">Deja en blanco lo que no sepas: se tratará como «desconocido», nunca como 0.</div>`;
    }
    const pl = v.players || [], g = (i, k) => (pl[i] && pl[i][k] != null) ? pl[i][k] : "";
    return `<div class="grid2"><label>Ganador<select id="t-w"><option value="">—</option><option value="A" ${v.winner === "A" ? "selected" : ""}>${esc(e.home)} (A)</option><option value="B" ${v.winner === "B" ? "selected" : ""}>${esc(e.away)} (B)</option></select></label>
      <label>Sets (juegos de A-B por set)<input id="t-s" placeholder="6-4 3-6 7-6" value="${(v.sets || []).map(s => s.join("-")).join(" ")}"></label>
      <label><input type="checkbox" id="t-r" ${v.retired ? "checked" : ""}> Retirada / abandono</label>
      <label>Aces A / B<span><input id="t-a0" value="${g(0, "aces")}"> / <input id="t-a1" value="${g(1, "aces")}"></span></label><label>Dobles faltas A / B<span><input id="t-d0" value="${g(0, "double_faults")}"> / <input id="t-d1" value="${g(1, "double_faults")}"></span></label></div>`;
  }
  function readForm(e) {
    const val = id => $(id).value;
    if (e.sport === "football") {
      const p2 = k => { const a = num(val("#f-" + k + "0")), b = num(val("#f-" + k + "1")); return a != null && b != null ? [a, b] : null; }, vals = {};
      [["ft", "ft"], ["ht", "ht"], ["corners", "co"], ["cards", "ca"], ["sot", "so"]].forEach(([k, i]) => { const x = p2(i); if (x) vals[k] = x; });
      const players = [...document.querySelectorAll("#f-pl .prow")].map(tr => { const o = { name: tr.querySelector(".pn").value.trim(), played: tr.querySelector(".pp").checked }; tr.querySelectorAll(".pk").forEach(i => { const n = num(i.value); if (n != null) o[i.dataset.k] = n; }); return o; }).filter(p => p.name);
      if (players.length) vals.players = players; return vals;
    }
    const vals = {}; if (val("#t-w")) vals.winner = val("#t-w"); const sets = [...val("#t-s").matchAll(/(\d+)\s*-\s*(\d+)/g)].map(m => [+m[1], +m[2]]); if (sets.length) vals.sets = sets; if ($("#t-r").checked) vals.retired = true;
    const pl = [[e.home, "0"], [e.away, "1"]].map(([n, i]) => { const o = { name: n }, a = num(val("#t-a" + i)), d = num(val("#t-d" + i)); if (a != null) o.aces = a; if (d != null) o.double_faults = d; return o; }).filter(o => o.aces != null || o.double_faults != null); if (pl.length) vals.players = pl; return vals;
  }
  let openForm = null;
  function renderEval() {
    const now = new Date().toISOString();
    let list = S.ev.filter(e => e.kickoff < now && S.pr.some(p => p.eventId === e.eventId) && (!filt.pend || !rsOf(e.eventId) || rsOf(e.eventId).status === "unconfirmed"));
    $("#e-list").innerHTML = `<div class="m">${list.length} eventos ${filt.pend ? "pendientes de resultado o confirmación" : "terminados"}</div>` + list.slice(0, 50).map(e => {
      const r = rsOf(e.eventId), id = esc(e.eventId);
      return `<div class="card"><div class="t"><b>${esc(e.home)} – ${esc(e.away)}</b><span class="m">${esc(e.competition)} · ${dtf(e.kickoff)} · ${BADGE[r ? r.status : "none"]}</span></div>
        ${r && r.source === "api" || (r && r.apiValues) ? `<div class="m">Dato de API: ${esc(JSON.stringify(r.source === "api" ? r.values : r.apiValues))}</div>` : ""}
        <div class="btns">${r && r.status === "unconfirmed" ? `<button data-act="confirm" data-id="${id}">Confirmar dato de API</button>` : ""}<button data-act="edit" data-id="${id}">${r ? "Corregir / completar" : "Introducir resultado"}</button></div>
        ${openForm === e.eventId ? `<div class="form">${formHtml(e, r)}<button data-act="save" data-id="${id}">Guardar resultado</button> <button data-act="cancel" data-id="${id}">Cancelar</button></div>` : ""}${evalTable(e)}</div>`;
    }).join("") || `<div class="empty">Nada pendiente.</div>`;
    $("#e-list").querySelectorAll("[data-act]").forEach(b => b.onclick = async () => {
      const id = b.dataset.id, e = S.ev.find(x => x.eventId === id);
      try {
        if (b.dataset.act === "edit") { openForm = id; }
        else if (b.dataset.act === "cancel") { openForm = null; }
        else if (b.dataset.act === "confirm") { await DB.confirmResult(id); msg("Resultado confirmado."); }
        else if (b.dataset.act === "save") { const vals = readForm(e); if (!Object.keys(vals).length) throw new Error("No has introducido ningún dato"); await DB.saveResult(id, vals); openForm = null; msg("Resultado guardado."); }
      } catch (err) { msg(err.message, false); }
      await reload(); renderAll();
    });
    const ap = $("#f-addp"); if (ap) ap.onclick = () => { const tr = document.createElement("tr"); tr.className = "prow"; tr.innerHTML = `<td><input class="pn"></td><td><input type="checkbox" class="pp" checked></td>${["goals", "assists", "sot", "shots", "cards"].map(k => `<td><input class="pk" data-k="${k}"></td>`).join("")}`; $("#f-pl").appendChild(tr); };
  }

  // ---------- 3. CENTRO DE APRENDIZAJE ----------
  const mfmt = (m, t) => t === "numeric" ? `MAE ${f3(m.mae)}` : `${pc(m.accuracy)}${m.wilson ? ` <span class="m">[${pc(m.wilson[0])}–${pc(m.wilson[1])}]</span>` : ""}`;
  function picksPanel() {
    const pr = L.pickRows(S.pr, S.rs, { onlyConfirmed: !inclApi }), ps = L.pickSummary(pr), o = ps.overall, line = (n, x) => `<tr><td>${n}</td><td>${x.n}</td><td>${x.wins}</td><td>${pc(x.rate)}${x.wilson ? ` <span class="m">[${pc(x.wilson[0])}–${pc(x.wilson[1])}]</span>` : ""}</td><td>${pc(x.meanP)}</td><td>${f3(x.brier)}</td><td>${x.roi != null ? (x.roi > 0 ? "+" : "") + (x.roi * 100).toFixed(1) + "% (n=" + x.nOdds + ")" : "—"}</td></tr>`;
    const last = pr.filter(r => r.status === "hit" || r.status === "miss").sort((a, b) => a.kickoff < b.kickoff ? 1 : -1).slice(0, 15);
    return `<h3>Picks recomendados: aciertos y fallos</h3>` + (o.n ? `<table><tr><th>Grupo</th><th>Resueltos</th><th>Acertados</th><th>% real [IC95]</th><th>% previsto medio</th><th>Brier</th><th>Rentab. teórica*</th></tr>${line("Todos", o)}${["Alta", "Media", "Arriesgada"].map(k => line(k, ps.byLevel[k])).join("")}${line("Con valor", ps.value)}</table>
      <div class="m">${M.sufficiency(o.n)}. *Beneficio medio por unidad apostada a cada pick con cuota real; con pocas apuestas no es concluyente. Si el % real queda por debajo del previsto, el modelo está confiado de más.</div>
      <table><caption>Últimos picks resueltos</caption>${last.map(r => `<tr><td>${esc(r.home)} – ${esc(r.away)}</td><td>${esc(r.label)}</td><td>${pc(r.p)}</td><td>${r.y ? '<span class="pill hit">acertado</span>' : '<span class="pill miss">fallado</span>'}${r.provisional ? ' <span class="m">(API)</span>' : ""}</td></tr>`).join("")}</table>` : `<div class="card m">Todavía no hay picks con resultado. Se rellenará solo cuando la API publique los marcadores.</div>`);
  }
  function autoPanel() {
    const c = D.modelConfig || {}, ch = c.champion || {}, cd = c.candidate, lg = (D.learningLog || []).slice().reverse(), cal = Object.keys(ch.calibration || {});
    return `<h3>Aprendizaje automático</h3><div class="card"><div class="m">Estado: <b>${c.auto_learn === false ? "desactivado" : "activo"}</b> · Modelo campeón: <b>${esc(ch.version)}</b> · ${cal.length ? "recalibraciones aplicadas: " + esc(cal.join(", ")) : "sin recalibraciones aún (modelo base)"}</div>
      ${cd ? `<div class="msgbox ok">Candidata en prueba (sombra): <b>${esc(cd.version)}</b> desde ${dtf(cd.createdAt)} · variables: ${esc((cd.changed || []).join(", "))}. Se promociona sola solo si mejora con datos posteriores; si no, se descarta.</div>` : `<div class="m" style="margin:6px 0">Sin candidata en prueba. Se crea una cuando una recalibración se valida con suficientes resultados (mínimo 100 eventos por variable y mejora significativa en el tramo reciente).</div>`}
      ${lg.length ? `<table><tr><th>Fecha</th><th>Decisión</th><th>Versión</th><th>Detalle</th></tr>${lg.map(e => `<tr><td>${dtf(e.at)}</td><td><span class="pill ${e.action === "promocion" ? "ok" : e.action === "descarte" ? "miss" : "meas"}">${esc(e.action)}</span></td><td>${esc(e.version)}</td><td>${esc(e.detalle || "")}</td></tr>`).join("")}</table>` : `<div class="m">Aún no hay decisiones registradas.</div>`}
      <div class="btns"><button id="l-exp">Exportar resultados para el aprendizaje automático</button></div>
      <div class="m">Los resultados que introduces a mano (tenis, córners, tarjetas…) solo viven en este navegador: descarga <b>manual_results.json</b> y súbelo a la raíz del repositorio para que el aprendizaje diario los use. Los marcadores de fútbol llegan solos por la API. Para volver a un modelo anterior, edita model_config.json.</div></div>`;
  }
  async function exportManual() {
    const rs = S.rs.filter(r => r.status === "confirmed" || r.status === "corrected").map(r => ({ eventId: r.eventId, status: r.status, values: r.values, updatedAt: r.updatedAt }));
    DB.download("manual_results.json", { app: "radar", exportedAt: new Date().toISOString(), results: rs }); msg(rs.length + " resultados exportados. Súbelo a la raíz del repositorio.");
  }
  function renderLearn() {
    const rows = L.buildRows(S.pr, S.rs, { onlyConfirmed: !inclApi }), prov = rows.filter(r => r.provisional).length;
    const sum = L.summarize(rows), cur = (D.modelConfig && D.modelConfig.champion) || { version: "poisson-v1.0", calibration: {} };
    let h = `<label class="m"><input type="checkbox" id="l-api" ${inclApi ? "checked" : ""}> Incluir resultados automáticos de la API aunque no los hayas confirmado a mano</label><div class="m">Usa la última predicción generada <b>antes</b> del inicio de cada evento. ${prov ? prov + " variables con resultado de API sin confirmar incluidas." : ""} Modelo campeón actual: <b>${esc(cur.version)}</b>.</div>` + picksPanel() + autoPanel();
    h += `<h3>Rendimiento por variable</h3>` + (sum.length ? `<div class="scroll"><table><tr><th>Variable</th><th>Versión</th><th>N</th><th>Ac.</th><th>Err.</th><th>Desc.</th><th>Anul.</th><th>Accuracy [IC95]</th><th>Prec.</th><th>Recall</th><th>Brier</th><th>vs base</th><th>vs mercado</th><th>LogLoss</th><th>Muestra</th></tr>${sum.map(s => {
      const m = s.m, b = s.type === "numeric" ? "" : `<td>${f3(m.brier)}</td><td>${m.brierBase != null ? (m.brier < m.brierBase ? "mejor " : "peor ") + f3(m.brierBase) : "—"}</td><td>${m.brierMarket != null ? `${f3(m.brierModelOnMarket)} vs ${f3(m.brierMarket)} (n=${m.nMarket})` : "—"}</td><td>${f3(m.logLoss)}</td>`;
      return `<tr><td>${esc(V.NAMES[s.varId.split("|")[0]] || s.varId)} <span class="m">${esc(s.varId)}</span></td><td>${esc(s.version)}${s.role === "shadow" ? " (sombra)" : ""}</td><td>${m.n || 0}</td><td>${s.hit}</td><td>${s.miss}</td><td>${s.unknown}</td><td>${s.void}</td><td>${s.type === "numeric" ? "—" : mfmt(m, s.type)}</td><td>${m.precision != null ? pc(m.precision) : "—"}</td><td>${m.recall != null ? pc(m.recall) : "—"}</td>${s.type === "numeric" ? `<td colspan="4">${mfmt(m, "numeric")}</td>` : b}<td>${esc(s.suficiencia)}</td></tr>`;
    }).join("")}</table></div><div class="m">Accuracy/precision/recall binarias usan el umbral 50 %. Brier y LogLoss: menor es mejor; «vs base» compara con predecir siempre la tasa de aciertos; «vs mercado» compara con la probabilidad implícita sin margen de las casas (solo donde hay cuotas).</div>` : `<div class="empty">Aún no hay resultados confirmados. Introduce o confirma resultados en «Evaluación».</div>`);
    const binVars = [...new Set(rows.filter(r => r.type === "binary" && (r.status === "hit" || r.status === "miss")).map(r => r.varId))]; if (!learnVar || !binVars.includes(learnVar)) learnVar = binVars[0] || "";
    if (learnVar) { const cal = M.calibration(rows.filter(r => r.varId === learnVar && r.type === "binary" && (r.status === "hit" || r.status === "miss") && r.role !== "shadow").map(r => ({ p: r.p, y: r.y })));
      h += `<h3>Calibración</h3><select id="l-var">${binVars.map(v => `<option ${v === learnVar ? "selected" : ""}>${esc(v)}</option>`).join("")}</select><table><tr><th>Prob. prevista</th><th>N</th><th>Prev. media</th><th>Frecuencia real</th></tr>${cal.filter(b => b.n).map(b => `<tr><td>${pc(b.from)}–${pc(b.to)}</td><td>${b.n}</td><td>${pc(b.meanP)}</td><td>${pc(b.freq)}</td></tr>`).join("")}</table><div class="m">Si la frecuencia real queda por debajo/encima de la prevista, el modelo está sobre/infraconfiado.</div>`; }
    const ctx = L.contextEffects(rows); h += `<h3>Efecto del contexto (exploratorio)</h3>` + (ctx.length ? `<table><tr><th>Variable</th><th>Factor</th><th>Grupo</th><th>N</th><th>Sesgo (real − previsto)</th><th>IC corregido</th><th>Señal</th></tr>${ctx.slice(0, 20).map(c => `<tr><td>${esc(c.variable)}</td><td>${esc(c.feature)}</td><td>${esc(c.group)}</td><td>${c.n}</td><td>${pc(c.bias)}</td><td>${c.ci ? pc(c.ci[0]) + " a " + pc(c.ci[1]) : "—"}</td><td>${c.senal ? '<span class="st warn">posible</span>' : "—"}</td></tr>`).join("")}</table><div class="m">Se prueban muchos grupos a la vez (${ctx[0].comparaciones} comparaciones): el intervalo está corregido, pero cualquier «señal» debe confirmarse con datos posteriores antes de actuar.</div>` : `<div class="m">Insuficientes datos (mínimo ${L.MIN_PROPOSE} por variable y 15 por grupo).</div>`);
    const props = L.proposeCalibrations(rows);
    h += `<h3>Propuestas de mejora</h3>` + (props.length ? props.map((p, i) => p.kind ? `<div class="card"><b>Recalibrar «${esc(p.varId)}»</b> <span class="m">(${esc(p.version)})</span><div>${p.validated ? '<span class="st hit">validada</span>' : '<span class="st warn">exploratoria</span>'} ${esc(p.estado)}</div>
      <div class="m">Ajuste con ${p.nTrain} eventos antiguos, evaluado en los ${p.nTest} más recientes. Brier de referencia en test ${f3(p.brierBase)} · mejora ${f3(p.improvement)} (IC95 ${f3(p.ci && p.ci[0])} a ${f3(p.ci && p.ci[1])}). Parámetros: a=${p.params.a.toFixed(3)}, b=${p.params.b.toFixed(3)}.</div>
      <div class="btns">${SUPPORTED.includes(p.varId) ? `<button data-pa="shadow" data-i="${i}">Probar en paralelo (sombra)</button>${p.validated ? `<button data-pa="approve" data-i="${i}">Aprobar como campeón…</button>` : `<span class="m">La aprobación se habilita al validarse.</span>`}` : `<span class="m">Aún no aplicable automáticamente a esta variable.</span>`}</div></div>` : `<div class="empty">${esc(p.varId)}: ${esc(p.estado)} (n=${p.n}).</div>`).join("") : `<div class="empty">Sin datos suficientes.</div>`);
    const cmp = L.compareVersions(rows); h += `<h3>Comparación de versiones</h3>` + (cmp.versions.length ? `<table><tr><th>Versión</th><th>Rol</th><th>N</th><th>Brier</th><th>LogLoss</th><th>Accuracy</th></tr>${cmp.versions.map(v => `<tr><td>${esc(v.version)}</td><td>${esc(v.role)}</td><td>${v.n}</td><td>${f3(v.brier)}</td><td>${f3(v.logLoss)}</td><td>${pc(v.accuracy)}</td></tr>`).join("")}</table>` : `<div class="m">Sin datos.</div>`)
      + (cmp.paired.length ? `<h4>Campeón vs sombra (mismos eventos, datos posteriores a la propuesta)</h4><table><tr><th>Candidata</th><th>N pares</th><th>Δ Brier (cand.−camp.)</th><th>IC95</th><th>Veredicto</th></tr>${cmp.paired.map(p => `<tr><td>${esc(p.version)}</td><td>${p.n}</td><td>${f3(p.meanDiffBrier)}</td><td>${p.ci ? f3(p.ci[0]) + " a " + f3(p.ci[1]) : "—"}</td><td>${p.mejor ? '<span class="st hit">mejor</span>' : "sin diferencia demostrada"}</td></tr>`).join("")}</table>` : "");
    h += `<h3>Modelos registrados</h3>` + (S.md.length ? `<table><tr><th>Versión</th><th>Estado</th><th>Creada</th><th>Nota</th></tr>${S.md.map(m => `<tr><td>${esc(m.version)}</td><td>${esc(m.status)}</td><td>${dtf(m.createdAt)}</td><td>${esc(m.note || "")}</td></tr>`).join("")}</table>` : `<div class="m">Ninguno todavía.</div>`);
    $("#l-body").innerHTML = h; const ia = $("#l-api"); if (ia) ia.onchange = () => { inclApi = ia.checked; renderLearn(); }; const le = $("#l-exp"); if (le) le.onclick = exportManual; const sel = $("#l-var"); if (sel) sel.onchange = () => { learnVar = sel.value; renderLearn(); };
    $("#l-body").querySelectorAll("[data-pa]").forEach(b => b.onclick = () => act(props[+b.dataset.i], b.dataset.pa));
  }
  async function act(p, kind) {
    const base = (D.modelConfig && D.modelConfig.champion) || { version: "poisson-v1.0", calibration: {} }, stamp = new Date().toISOString().slice(0, 10).replace(/-/g, ""), ver = base.version.split("+")[0] + "+cal-" + stamp;
    const cal = { ...(base.calibration || {}), [p.varId]: { a: +p.params.a.toFixed(5), b: +p.params.b.toFixed(5) } }, mdl = { version: ver, calibration: cal };
    if (kind === "approve" && prompt("Vas a aprobar «" + ver + "» como modelo campeón.\nNo se aplica solo: descargarás model_config.json y deberás subirlo al repositorio.\n\nEscribe APROBAR para continuar:") !== "APROBAR") return;
    await DB.put("proposals", { id: p.id, ...p, status: kind === "approve" ? "approved" : "shadow", at: new Date().toISOString() });
    await DB.put("models", { version: ver, status: kind === "approve" ? "champion" : "candidate", createdAt: new Date().toISOString(), basedOn: base.version, calibration: cal, note: "Recalibración de " + p.varId + " (n=" + p.n + ")" });
    DB.download("model_config.json", kind === "approve" ? L.buildConfig(D.modelConfig, mdl, null) : L.buildConfig(D.modelConfig, undefined, mdl));
    msg(kind === "approve" ? "Aprobado. Sube model_config.json a la raíz del repositorio (sustituyendo el actual)." : "Candidata en sombra: sube model_config.json al repositorio; correrá en paralelo sin afectar al modelo campeón."); await reload(); renderAll();
  }

  function renderAll() { renderBanner(); renderHistory(); renderManual(); renderEval(); renderLearn(); }
  async function init(data) {
    D = data; await DB.open(); DB.requestPersistence(); await reload();
    $("#h-sync").onclick = sync; $("#h-exp").onclick = doExport; $("#h-imp").onchange = e => { if (e.target.files[0]) doImport(e.target.files[0]); e.target.value = ""; };
    $("#h-sport").onchange = e => { filt.sport = e.target.value; renderHistory(); }; $("#h-ver").onchange = e => { filt.ver = e.target.value; renderHistory(); }; $("#h-q").oninput = e => { filt.q = e.target.value; renderHistory(); };
    $("#e-pend").onchange = e => { filt.pend = e.target.checked; renderEval(); };
    renderAll(); await sync();
  }
  root.RadarUI = { init };
})(window);
