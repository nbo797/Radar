# Radar 2.0 — análisis, historial, evaluación y aprendizaje

## Estructura
| Archivo | Qué hace |
|---|---|
| `radar.py` | Pipeline diario: APIs → noticias → modelo Poisson → picks razonados → `docs/` |
| `learn.py` | Aprendizaje automático con candado de validación (sombra → promoción) |
| `template.html` | Web (identidad visual original + 3 secciones nuevas) |
| `web/vars.js` | Qué significa cada variable y cómo se evalúa (acierto / error / desconocido / anulado) |
| `web/metrics.js` | Accuracy, precision, recall, Brier, Log Loss, MAE, calibración, bootstrap |
| `web/db.js` | IndexedDB (esquema v1 con migraciones), exportar/importar JSON, protección contra pérdida |
| `web/learn.js` | Errores históricos, efecto del contexto, propuestas con validación temporal, comparación de versiones |
| `web/ui.js` | Historial · Evaluación · Aprendizaje |
| `model_config.json` | Versión del modelo campeón (y candidato en sombra). Solo cambia si TÚ lo subes |
| `tennis_manual.csv` | Partidos de tenis manuales. Columnas `torneo` y `categoria` (p. ej. «Challenger 75»). La fila `ejemplo=si` se ignora |
| `tests/` | Pruebas (Python con APIs simuladas, JS, y humo de la interfaz) |

## Flujo de datos
1. La Action diaria genera `docs/history/AAAA-MM-DDTHHMMSSZ.json` (**solo se añaden, nunca se sobrescriben**) con eventos, predicciones (todas las variables, versión de modelo, contexto) y combinadas.
2. También actualiza `docs/results.json` con marcadores finales/descanso de football-data.org.
3. En la web, «Sincronizar» importa ese historial a IndexedDB. Los resultados de la API entran como **sin confirmar** y no cuentan para el aprendizaje hasta que los confirmes o corrijas.
4. Los resultados manuales (córners, tarjetas, tiros, jugadores, sets, tenis…) se introducen en «Evaluación». Lo que dejes en blanco es «desconocido», nunca un fallo.

## Reglas de rigor
- Solo se evalúa la última predicción generada **antes** del inicio del evento.
- Las predicciones manuales solo se aceptan antes del inicio.
- Métricas con mínimos de muestra (30 orientativo, 100 suficiente) e intervalos de confianza.
- El efecto del contexto es exploratorio, con corrección por comparaciones múltiples.
- Una recalibración solo se «valida» si mejora el Brier de forma significativa en el 30 % más reciente (ajuste con el 70 % más antiguo).
- Ningún modelo se actualiza solo: «Probar en paralelo» o «Aprobar» descargan `model_config.json`; tú lo subes al repositorio.

## Copias de seguridad
IndexedDB es local al navegador. Exporta JSON a menudo (la web avisa tras 7 días). Importar fusiona sin borrar y muestra una vista previa; si vas a sobrescribir resultados, se descarga una copia antes.

## Tests
`python3 tests/test_radar.py` · `python3 tests/test_learn.py` · `npm i fake-indexeddb jsdom` y `node tests/test_js.js` · `SMOKE_OUT=/tmp/smoke python3 tests/test_radar.py && node tests/test_ui.js`.
Los datos de las pruebas son sintéticos y solo existen en `tests/`.

## Filtro de tenis
Entran: **Challenger 100, 125 y 175**, **Grand Slams** y grandes torneos (Masters 1000 y Finales). Se excluyen Challenger 50 y 75 y ATP/WTA 250 y 500. Si la API no indica la categoría de un Challenger, entra marcado como «categoría sin verificar». En `tennis_manual.csv` escribe «Challenger 100/125/175» o «Grand Slam» en `torneo` o `categoria`; si no, la fila se descarta (aviso en el log). Columnas opcionales que alimentan el razonamiento: `forma_a`, `forma_b`, `h2h`, `superficie`.

## Picks y razonamiento
Para cada partido se proponen hasta 3 picks (uno por familia: resultado, goles, ambos marcan) con nivel Alta / Media / Arriesgada y desplegable «a favor / en contra». Todo se construye con datos reales: probabilidad del modelo, cuota justa y de mercado, goles esperados, forma reciente (local en casa / visitante fuera), goles, ambos marcan, +2.5, porterías a cero, cruces anteriores y noticias. Los picks se guardan en el historial y se evalúan después contra el resultado.

## Noticias
Google News RSS, 2 búsquedas por equipo/jugador, últimos 4 días. Cada titular se clasifica por palabras clave (baja, sanción, duda, regreso, entrenador). El impacto en el ataque se limita a −9 % / +4 % y cuenta como mucho 2 titulares por categoría. **No lee el artículo completo**: es un aviso, verifica la fuente.

## Aprendizaje automático (con salvaguardas)
`learn.py` corre al inicio de cada actualización:
1. Mide la calibración del modelo campeón con los resultados ya conocidos.
2. Si una recalibración mejora de forma significativa en el 30 % más reciente (ajuste con el 70 % antiguo) y cumple los límites de seguridad, pasa a **candidata en sombra**.
3. Solo se promociona a campeona si mejora con eventos **posteriores a su creación**; si no mejora tras suficientes datos, se descarta.
Todo queda en `docs/models/log.json`. Se desactiva con `"auto_learn": false` en `model_config.json`. Para volver atrás, edita `model_config.json` (las versiones anteriores constan en el log).
Mínimos: 100 eventos por variable para proponer; 60 pares para promover; 200 para descartar. Con ~25 partidos por semana el aprendizaje es lento: es intencionado, para no aprender ruido.
Los resultados de tenis y los manuales entran en el aprendizaje si exportas `manual_results.json` desde la web (Aprendizaje) y lo subes a la raíz del repositorio.
