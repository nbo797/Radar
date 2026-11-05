/* RadarDB: IndexedDB con esquema versionado, historial inmutable, exportar/importar JSON y protección contra pérdida. */
(function (root) {
  const SCHEMA = 1, NAME = "radar";
  const STORES = { events: "eventId", predictions: "predId", combos: "comboId", results: "eventId", models: "version", proposals: "id", meta: "key", resultsLog: null };
  const IMMUTABLE = ["events", "predictions", "combos"];           // solo se añaden; no hay API para modificarlas ni borrarlas
  const MIG = { 1: db => { for (const [s, k] of Object.entries(STORES)) { const st = k ? db.createObjectStore(s, { keyPath: k }) : db.createObjectStore(s, { autoIncrement: true }); if (s === "predictions") st.createIndex("eventId", "eventId"); } } };
  let _db = null;
  const rq = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function backupIfNeeded() {                                // antes de migrar: descarga automática de una copia
    if (typeof indexedDB === "undefined" || !indexedDB.databases) return;
    const f = (await indexedDB.databases()).find(d => d.name === NAME); if (!f || f.version >= SCHEMA) return;
    const old = await new Promise((res, rej) => { const r = indexedDB.open(NAME, f.version); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const dump = await exportFrom(old, f.version); old.close();
    if (typeof document !== "undefined") download("radar-copia-previa-migracion-v" + f.version + ".json", dump);
  }
  async function open() {
    if (_db) return _db; await backupIfNeeded().catch(() => {});
    _db = await new Promise((res, rej) => {
      const r = indexedDB.open(NAME, SCHEMA);
      r.onupgradeneeded = e => { for (let v = e.oldVersion + 1; v <= SCHEMA; v++) MIG[v](r.result, r.transaction); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error("Base de datos bloqueada: cierra otras pestañas de Radar"));
    }); return _db;
  }
  const all = async s => rq((await open()).transaction(s).objectStore(s).getAll());
  const get = async (s, k) => rq((await open()).transaction(s).objectStore(s).get(k));
  const put = async (s, o) => { if (IMMUTABLE.includes(s)) throw new Error(s + " es inmutable"); return rq((await open()).transaction(s, "readwrite").objectStore(s).put(o)); };
  async function add(s, o) {                                       // true si se añadió; false si ya existía (nunca sobrescribe)
    const db = await open();
    return new Promise((res, rej) => { const r = db.transaction(s, "readwrite").objectStore(s).add(o); r.onsuccess = () => res(true); r.onerror = e => { if (r.error && r.error.name === "ConstraintError") { e.preventDefault(); res(false); } else rej(r.error); }; });
  }
  async function exportFrom(db, ver) {
    const out = { app: "radar", schemaVersion: ver, exportedAt: new Date().toISOString(), stores: {} };
    for (const s of Object.keys(STORES)) { try { out.stores[s] = await rq(db.transaction(s).objectStore(s).getAll()); } catch (e) { out.stores[s] = []; } }
    return out;
  }
  const exportAll = async () => exportFrom(await open(), SCHEMA);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function validate(j) {
    if (!j || j.app !== "radar" || typeof j.stores !== "object") throw new Error("El archivo no es una exportación de Radar");
    if (j.schemaVersion > SCHEMA) throw new Error("Exportación de una versión más nueva (" + j.schemaVersion + "); actualiza Radar");
  }
  /* Vista previa: no escribe nada. */
  async function previewImport(j) {
    validate(j); const rep = {};
    for (const [s, k] of Object.entries(STORES)) {
      const inc = j.stores[s] || [], cur = k ? new Map((await all(s)).map(x => [x[k], x])) : null; let nw = 0, eq = 0, conflict = 0;
      for (const o of inc) { if (!k) { nw++; continue; } const c = cur.get(o[k]); if (!c) nw++; else if (same(c, o)) eq++; else conflict++; }
      rep[s] = { nuevos: nw, iguales: eq, conflictos: conflict };
    }
    return rep;
  }
  /* Fusiona sin borrar. Inmutables: solo añade. Resultados/modelos/propuestas en conflicto: se conservan los actuales salvo overwriteResults (si el importado es más reciente). */
  async function applyImport(j, { overwriteResults = false } = {}) {
    validate(j); const sum = { añadidos: 0, conservados: 0, sobrescritos: 0 };
    for (const [s, k] of Object.entries(STORES)) {
      if (s === "meta") continue; const inc = j.stores[s] || [];
      if (!k) { const ex = new Set((await all(s)).map(x => x.eventId + "|" + x.at)); for (const o of inc) if (!ex.has(o.eventId + "|" + o.at)) { await rq((await open()).transaction(s, "readwrite").objectStore(s).add(o)); sum.añadidos++; } continue; }
      for (const o of inc) {
        if (await add(s, o)) { sum.añadidos++; continue; }
        const cur = await get(s, o[k]);
        if (s === "results" && overwriteResults && !same(cur, o) && (o.updatedAt || "") > (cur.updatedAt || "")) { await logChange(cur.eventId, "importación", cur, o); await rq((await open()).transaction(s, "readwrite").objectStore(s).put(o)); sum.sobrescritos++; }
        else sum.conservados++;
      }
    }
    return sum;
  }
  const logChange = async (eventId, motivo, before, after) => rq((await open()).transaction("resultsLog", "readwrite").objectStore("resultsLog").add({ eventId, at: new Date().toISOString(), motivo, before, after }));
  /* Guardar resultado: manual = confirmado; si sustituye a otro distinto queda registrado el cambio (trazabilidad). */
  async function saveResult(eventId, values, { source = "manual", status = "confirmed" } = {}) {
    const cur = await get("results", eventId), now = new Date().toISOString();
    const rec = { eventId, source, status: cur && cur.source === "api" && source === "manual" && !same(cur.values, values) ? "corrected" : status, values, updatedAt: now, apiValues: cur && cur.source === "api" ? cur.values : (cur && cur.apiValues) || null };
    if (cur && !same(cur.values, values)) await logChange(eventId, "edición", cur, rec);
    await put("results", rec); return rec;
  }
  async function confirmResult(eventId) { const c = await get("results", eventId); if (!c) return null; const r = { ...c, status: "confirmed", updatedAt: new Date().toISOString() }; await logChange(eventId, "confirmación", c, r); await put("results", r); return r; }
  async function deleteResult(eventId) { const c = await get("results", eventId); if (!c) return; await logChange(eventId, "borrado", c, null); await rq((await open()).transaction("results", "readwrite").objectStore("results").delete(eventId)); }
  const getMeta = async k => { const r = await get("meta", k); return r ? r.value : null; };
  const setMeta = (k, v) => put("meta", { key: k, value: v });
  const requestPersistence = async () => (typeof navigator !== "undefined" && navigator.storage && navigator.storage.persist) ? navigator.storage.persist() : false;
  function download(name, obj) { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 1)], { type: "application/json" })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
  const api = { SCHEMA, STORES, open, all, get, put, add, exportAll, previewImport, applyImport, saveResult, confirmResult, deleteResult, getMeta, setMeta, requestPersistence, download, logChange };
  root.RadarDB = api; if (typeof module !== "undefined") module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
