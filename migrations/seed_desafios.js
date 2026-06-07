/* Seed dos Desafios da Home como registros REAIS em conteudo_treinos.
 * Substitui a antiga lista mock do componente ChallengesSection (frontend).
 * Cada desafio é um treino com secao_home = 'desafio'.
 *
 * Idempotente: só insere se ainda não existir um treino com o mesmo título
 * marcado como 'desafio' (case-insensitive).
 *
 * Para remover depois (rollback):
 *   DELETE FROM conteudo_treinos
 *   WHERE secao_home = 'desafio' AND title IN (
 *     'Prancha','Corrida','Salto box','Burpee','Flexões','Corda','Afundo','Barra Fixa'
 *   );
 *
 * Uso: node migrations/seed_desafios.js
 */
require("dotenv").config();
const postgres = require("postgres");

const sql = postgres(process.env.DATABASE_URL, {
  ssl: { rejectUnauthorized: false },
  max: 1,
  prepare: false,
  onnotice: () => {},
});

// ── Conjunto de desafios (antes mockados no ChallengesSection) ────────────────
const DESAFIOS = [
  {
    title: "Prancha",
    specialty: "Core",
    level: "Iniciante",
    minutes: "10 min",
    calories: "80 Kcal",
    image_url:
      "https://img.freepik.com/free-photo/full-shot-man-doing-plank_23-2149036348.jpg?w=1060",
    description:
      "Desafio da Prancha: sustente a posição isométrica o máximo de tempo possível e evolua a cada dia. Foco total no core e na respiração.",
    exercicios: [
      { nome: "Prancha frontal", series: "4", repeticoes: "30s", descanso: "30s", observacoes: "Mantenha o quadril alinhado, sem arquear a lombar." },
      { nome: "Prancha lateral", series: "3", repeticoes: "20s", descanso: "20s", observacoes: "Alterne os lados a cada série." },
    ],
  },
  {
    title: "Corrida",
    specialty: "Cardio",
    level: "Intermediário",
    minutes: "25 min",
    calories: "300 Kcal",
    image_url:
      "https://img.freepik.com/free-photo/sportsman-runs-jump-into-sky_158595-5930.jpg?w=1480",
    description:
      "Desafio da Corrida: complete a distância proposta mantendo um ritmo constante. Ideal para ganhar fôlego e resistência cardiovascular.",
    exercicios: [
      { nome: "Aquecimento (caminhada)", series: "1", repeticoes: "5 min", descanso: "0s", observacoes: "Ritmo leve para preparar o corpo." },
      { nome: "Corrida contínua", series: "1", repeticoes: "20 min", descanso: "0s", observacoes: "Mantenha a respiração controlada." },
    ],
  },
  {
    title: "Salto box",
    specialty: "Pliometria",
    level: "Avançado",
    minutes: "15 min",
    calories: "220 Kcal",
    image_url:
      "https://img.freepik.com/free-photo/full-shot-man-exercising-with-box_23-2149324736.jpg?w=1060",
    description:
      "Desafio do Salto na Caixa: explosão e potência de membros inferiores. Atenção à aterrissagem suave para proteger os joelhos.",
    exercicios: [
      { nome: "Box jump", series: "5", repeticoes: "10", descanso: "60s", observacoes: "Aterrisse com os joelhos levemente flexionados." },
      { nome: "Agachamento livre", series: "3", repeticoes: "15", descanso: "45s", observacoes: "" },
    ],
  },
  {
    title: "Burpee",
    specialty: "Full Body",
    level: "Avançado",
    minutes: "12 min",
    calories: "200 Kcal",
    image_url:
      "https://img.freepik.com/free-photo/full-shot-fit-woman-training-indoors_23-2149324736.jpg?w=1480",
    description:
      "Desafio do Burpee: o exercício de corpo inteiro mais intenso. Complete o número de repetições no menor tempo possível.",
    exercicios: [
      { nome: "Burpee completo", series: "5", repeticoes: "12", descanso: "60s", observacoes: "Peito no chão e salto no topo." },
    ],
  },
  {
    title: "Flexões",
    specialty: "Peito",
    level: "Iniciante",
    minutes: "10 min",
    calories: "120 Kcal",
    image_url:
      "https://img.freepik.com/free-photo/full-shot-sporty-man-exercising_23-2149326162.jpg?w=1480",
    description:
      "Desafio das Flexões: aumente o número de repetições a cada dia. Trabalha peito, ombros e tríceps com o peso do corpo.",
    exercicios: [
      { nome: "Flexão de braço", series: "4", repeticoes: "15", descanso: "45s", observacoes: "Corpo reto da cabeça aos calcanhares." },
      { nome: "Flexão diamante", series: "3", repeticoes: "10", descanso: "45s", observacoes: "Foco no tríceps." },
    ],
  },
  {
    title: "Corda",
    specialty: "Cardio",
    level: "Intermediário",
    minutes: "15 min",
    calories: "250 Kcal",
    image_url:
      "https://img.freepik.com/free-photo/athletic-woman-working-out-gym_52683-117192.jpg?w=1480",
    description:
      "Desafio da Corda: coordenação e queima calórica em alta intensidade. Sustente o maior número de saltos sem errar.",
    exercicios: [
      { nome: "Pular corda", series: "5", repeticoes: "1 min", descanso: "45s", observacoes: "Saltos baixos e ritmados." },
    ],
  },
  {
    title: "Afundo",
    specialty: "Pernas",
    level: "Intermediário",
    minutes: "15 min",
    calories: "180 Kcal",
    image_url:
      "https://img.freepik.com/free-photo/close-up-woman-doing-crossfit-workout_23-2149080458.jpg?w=1480",
    description:
      "Desafio do Afundo: fortaleça pernas e glúteos com unilaterais. Mantenha o tronco ereto durante todo o movimento.",
    exercicios: [
      { nome: "Afundo alternado", series: "4", repeticoes: "12", descanso: "45s", observacoes: "Joelho da frente alinhado com o pé." },
      { nome: "Afundo búlgaro", series: "3", repeticoes: "10", descanso: "45s", observacoes: "Pé de trás apoiado no banco." },
    ],
  },
  {
    title: "Barra Fixa",
    specialty: "Costas",
    level: "Avançado",
    minutes: "12 min",
    calories: "150 Kcal",
    image_url:
      "https://img.freepik.com/free-photo/fitness-boy-stretching_23-2148017323.jpg?w=1060",
    description:
      "Desafio da Barra Fixa: o teste de força das costas e bíceps. Some o máximo de repetições ao longo das séries.",
    exercicios: [
      { nome: "Barra fixa pronada", series: "5", repeticoes: "Máx", descanso: "90s", observacoes: "Subida controlada, queixo acima da barra." },
    ],
  },
];

(async () => {
  try {
    console.log(`→ Semeando ${DESAFIOS.length} desafios em conteudo_treinos...\n`);
    let inserted = 0;
    let skipped = 0;

    for (const d of DESAFIOS) {
      const existing = await sql`
        SELECT id FROM conteudo_treinos
        WHERE secao_home = 'desafio' AND LOWER(title) = LOWER(${d.title})
        LIMIT 1
      `;
      if (existing.length > 0) {
        skipped++;
        console.log(`  • "${d.title}" já existia (pulado)`);
        continue;
      }

      const [res] = await sql`
        INSERT INTO conteudo_treinos (
          title, calories, minutes, image_url, specialty, level, description,
          exercicios, secao_home, ativo, created_at
        ) VALUES (
          ${d.title}, ${d.calories}, ${d.minutes}, ${d.image_url}, ${d.specialty},
          ${d.level}, ${d.description}, ${sql.json(d.exercicios)}, 'desafio', TRUE, NOW()
        )
        RETURNING id;
      `;
      inserted++;
      console.log(`  ✓ "${d.title}" criado (id ${res.id})`);
    }

    const [{ count }] = await sql`
      SELECT COUNT(*)::int AS count FROM conteudo_treinos WHERE secao_home = 'desafio'
    `;
    console.log(`\n✅ Seed concluído: ${inserted} inseridos, ${skipped} pulados.`);
    console.log(`   Total de desafios no banco: ${count}`);
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
