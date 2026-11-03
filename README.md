# Radar de apuestas (gratis, se actualiza solo cada día)

## Qué hace
1. Descarga resultados y calendario (football-data.org): LaLiga, Champions League, Premier League y Serie A (opcional).
2. Ajusta un modelo Poisson (ataque/defensa por equipo, más peso a lo reciente) → probabilidades de 1X2, +2.5 y ambos marcan.
3. Busca titulares de lesiones/bajas de los últimos 3 días en Google News (RSS) y baja un 3 % el ataque del equipo por cada titular de baja (máx. 9 %).
4. Descarga cuotas reales (The Odds API), coge el mejor precio entre casas y calcula el valor.
5. Genera combinadas de 5 niveles y una sección de tenis.
6. Escribe `docs/index.html`, que GitHub Pages publica gratis.

## Puesta en marcha (≈15 min, 0 €)
1. **Claves gratis**
   - football-data.org → "Register" → recibes la clave por email (plan gratis: 10 peticiones/min).
   - the-odds-api.com → "Get API Key" (500 créditos/mes, sin tarjeta).
2. **GitHub**: crea un repositorio nuevo (público o privado) y sube todo el contenido de esta carpeta.
3. En el repo: *Settings → Secrets and variables → Actions → New repository secret*. Crea `FOOTBALL_DATA_KEY` y `ODDS_API_KEY`.
4. *Settings → Pages* → Source: "Deploy from a branch", rama `main`, carpeta `/docs`.
5. *Actions → Actualizar radar → Run workflow* para la primera ejecución. A partir de ahí corre cada día a las 06:00 UTC.
6. Tu web queda en `https://TU_USUARIO.github.io/NOMBRE_REPO/`.

Prueba local: `pip install -r requirements.txt`, `export FOOTBALL_DATA_KEY=... ODDS_API_KEY=...`, `python radar.py`.

## Límites gratis
- **Créditos de cuotas**: cada competición cuesta ~2 créditos por ejecución (h2h + totales) → 8/día → ~240/mes. El tenis cuesta 1 por torneo y día (`MAX_TENNIS = 6` → ~180/mes). Total ≈ 420 de 500. Si te quedas sin créditos, baja `MAX_TENNIS` o quita Serie A.
- **Europa League, Conference y Copa del Rey**: el plan gratis de football-data.org no los incluye. Cuando quieras, añade `soccer_uefa_europa_league` a la lista de cuotas y usa otra fuente de resultados (API-Football gratis: 100 peticiones/día).
- **Challengers**: el script prioriza los torneos con "challenger" en la lista de The Odds API (en el log de Actions verás qué torneos de tenis existen). Si no aparecen, las APIs gratis no los cubren. Por eso existe `tennis_manual.csv`: añade filas (jugadores, ranking, cuotas) y el script calcula probabilidad (ranking + cuotas sin margen) y marca "candidato seguro" si supera 72 %.
- **Tarjetas y tiros de jugador**: no hay fuente gratuita fiable; no se incluyen.
- Ratings: se mezclan ligas distintas en la Champions, así que los cruces entre países son menos precisos que los domésticos.

## Aviso
Es un modelo sencillo y no garantiza beneficios. Valida con pocas apuestas antes de subir importes y juega con responsabilidad.
