/* Seed de dados de teste no histórico (user_workouts) para visualizar a UI.
 * Idempotente: client_id "seed-*" + ON CONFLICT (id_us, client_id) DO NOTHING.
 * Para remover depois: DELETE FROM user_workouts WHERE client_id LIKE 'seed-%';
 *
 * Uso: node migrations/seed_user_workouts.js [email]
 */
require("dotenv").config();
const postgres = require("postgres");

const EMAIL = process.argv[2] || "josulima90@gmail.com";

const sql = postgres(process.env.DATABASE_URL, {
  ssl: { rejectUnauthorized: false },
  max: 1,
  prepare: false,
  onnotice: () => {},
});

// ── Helpers de geração ──────────────────────────────────────────────────────
function paceStr(distKm, sec) {
  const secPerKm = sec / distKm;
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
function speedKmh(distKm, sec) {
  return Number((distKm / (sec / 3600)).toFixed(1));
}
function kcalOf(distKm) {
  return Math.round(distKm * 75 * 1.036);
}
function daysAgo(d) {
  const dt = new Date();
  dt.setDate(dt.getDate() - d);
  dt.setHours(7, 30, 0, 0);
  return dt.toISOString();
}
// Rota plausível: linha levemente sinuosa em São Paulo cobrindo ~distKm.
function fakeRoute(distKm, n = 12) {
  const lat0 = -23.5613;
  const lng0 = -46.6565;
  const dLat = distKm / 111.32;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    pts.push({
      latitude: Number((lat0 + dLat * t).toFixed(6)),
      longitude: Number((lng0 + Math.sin(t * Math.PI * 2) * 0.0008).toFixed(6)),
    });
  }
  return pts;
}
// Splits por km (corrida), com pequena variação de ritmo.
function fakeSplits(distKm, sec) {
  const fullKm = Math.floor(distKm);
  const basePace = sec / distKm;
  const splits = [];
  let acc = 0;
  for (let km = 1; km <= fullKm; km++) {
    const variance = (Math.sin(km) * 6); // ±6s
    const kmPace = basePace + variance;
    acc += kmPace;
    const m = Math.floor(kmPace / 60);
    const s = Math.round(kmPace % 60);
    const tm = Math.floor(acc / 60);
    const ts = Math.round(acc % 60);
    splits.push({
      km,
      time: `${tm}:${String(ts).padStart(2, "0")}`,
      pace: `${m}:${String(s).padStart(2, "0")}`,
    });
  }
  return splits;
}

// ── Conjunto de treinos de teste ────────────────────────────────────────────
// Pensado para o recorde de distância/duração/kcal ser a Corrida de 8,4 km e o
// melhor pace ser a Corrida de 5,1 km (mais recente) — assim os 🏆 ficam claros.
const WORKOUTS = [
  { type: "Corrida", distKm: 3.2, sec: 1110, day: 12 },
  { type: "Corrida", distKm: 5.0, sec: 1635, day: 8 },
  { type: "Corrida", distKm: 8.4, sec: 2650, day: 4 }, // recorde dist/dur/kcal
  { type: "Corrida", distKm: 5.1, sec: 1540, day: 1 }, // melhor pace (5:02)
  { type: "Ciclismo", distKm: 15.3, sec: 2280, day: 6 },
  { type: "Ciclismo", distKm: 28.7, sec: 4080, day: 2 }, // recorde ciclismo
];

(async () => {
  try {
    const [user] = await sql`SELECT id_us, nome FROM usuarios WHERE email = ${EMAIL}`;
    if (!user) {
      console.error(`Usuário não encontrado para email: ${EMAIL}`);
      process.exit(1);
    }
    const idUs = user.id_us;
    console.log(`→ Semeando histórico para id_us=${idUs} (${user.nome || EMAIL})\n`);

    let inserted = 0;
    let skipped = 0;
    for (let i = 0; i < WORKOUTS.length; i++) {
      const w = WORKOUTS[i];
      const clientId = `seed-${w.type.toLowerCase()}-${i + 1}`;
      const isRun = w.type === "Corrida";
      const row = {
        pace: paceStr(w.distKm, w.sec),
        speed: speedKmh(w.distKm, w.sec),
        kcal: kcalOf(w.distKm),
        route: fakeRoute(w.distKm),
        splits: isRun ? fakeSplits(w.distKm, w.sec) : [],
        date: daysAgo(w.day),
      };

      const [res] = await sql`
        INSERT INTO user_workouts
          (id_us, client_id, tipo, data, duracao_seg, distancia_km, pace_medio, velocidade_media_kmh, kcal, rota, splits)
        VALUES (
          ${idUs}, ${clientId}, ${w.type}, ${row.date}, ${w.sec}, ${w.distKm},
          ${row.pace}, ${row.speed}, ${row.kcal}, ${sql.json(row.route)}, ${sql.json(row.splits)}
        )
        ON CONFLICT (id_us, client_id) DO NOTHING
        RETURNING id;
      `;
      if (res) {
        inserted++;
        console.log(
          `  ✓ ${w.type.padEnd(8)} ${String(w.distKm).padStart(5)} km · ${row.pace}/km · ${row.kcal} kcal · ${w.day}d atrás (id ${res.id})`
        );
      } else {
        skipped++;
        console.log(`  • ${clientId} já existia (pulado)`);
      }
    }

    const [{ count }] = await sql`
      SELECT COUNT(*)::int AS count FROM user_workouts WHERE id_us = ${idUs}
    `;
    console.log(`\n✅ Seed concluído: ${inserted} inseridos, ${skipped} pulados.`);
    console.log(`   Total de treinos do usuário no banco: ${count}`);
    await sql.end({ timeout: 5 });
    process.exit(0);
  } catch (err) {
    console.error("✗ Falha no seed:", err.message);
    try {
      await sql.end({ timeout: 5 });
    } catch {}
    process.exit(1);
  }
})();
