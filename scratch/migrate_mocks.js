const postgres = require('postgres');
require('dotenv').config();

const sql = postgres(process.env.DATABASE_URL, {
  ssl: { rejectUnauthorized: false }
});

async function migrate() {
  console.log('🚀 Iniciando migração de treinos mockados...');

  const workouts = [
    {
      title: 'Agachamento',
      calories: '180 - 250 Kcal',
      minutes: '15 min',
      image_url: 'https://res.cloudinary.com/ditlmzgrh/image/upload/v1757229915/image_71_jntmsv.jpg',
      specialty: 'Pernas',
      level: 'Iniciante',
      description: 'Treino clássico focado em força e estabilidade dos membros inferiores.'
    },
    {
      title: 'Supino',
      calories: '150 - 200 Kcal',
      minutes: '12 min',
      image_url: 'https://res.cloudinary.com/ditlmzgrh/image/upload/v1757229915/image_txncpp.jpg',
      specialty: 'Peitoral',
      level: 'Intermediário',
      description: 'Desenvolvimento de força peitoral e tríceps com técnica de barra.'
    },
    {
      title: 'Remada curvada',
      calories: '160 - 220 Kcal',
      minutes: '12 min',
      image_url: 'https://res.cloudinary.com/ditlmzgrh/image/upload/v1757229918/image_75_drh4vh.jpg',
      specialty: 'Costas',
      level: 'Intermediário',
      description: 'Foco em densidade das costas e fortalecimento da postura.'
    },
    {
      title: 'Levantamento Terra',
      calories: '160 - 220 Kcal',
      minutes: '15 min',
      image_url: 'https://res.cloudinary.com/ditlmzgrh/image/upload/v1757229918/image111_gu6iim.jpg',
      specialty: 'Full Body',
      level: 'Avançado',
      description: 'Exercício composto de alta intensidade para força bruta e estabilização.'
    },
    {
      title: 'Puxada na Barra',
      calories: '140 - 200 Kcal',
      minutes: '12 min',
      image_url: 'https://res.cloudinary.com/ditlmzgrh/image/upload/v1757229918/image_73_co9eqf.jpg',
      specialty: 'Costas',
      level: 'Avançado',
      description: 'Treino focado em amplitude e definição dos dorsais superiores.'
    },
    {
      title: 'Flexão de braços',
      calories: '9 - 18 Kcal',
      minutes: '10 min',
      image_url: 'https://img.freepik.com/free-photo/attractive-muscular-guy-doing-push-ups-exercises-workout-outdoors_8353-6810.jpg?w=1480',
      specialty: 'Peitoral',
      level: 'Iniciante',
      description: 'Exercício fundamental de calistenia para iniciantes.'
    },
    {
      title: 'Desenvolvimento Ombro',
      calories: '18 - 24 Kcal',
      minutes: '15 min',
      image_url: 'https://img.freepik.com/free-photo/back-view-woman-exercising-with-dumbbells_23-2147789670.jpg?w=1480',
      specialty: 'Ombros',
      level: 'Intermediário',
      description: 'Foco em deltóides e mobilidade escapular.'
    },
    {
      title: 'Puxada frontal',
      calories: '12 - 18 Kcal',
      minutes: '12 min',
      image_url: 'https://img.freepik.com/free-photo/side-view-man-working-out-gym-with-medical-mask-his-forearm_23-2148769885.jpg?w=1480',
      specialty: 'Costas',
      level: 'Avançado',
      description: 'Isolamento de grande dorsal para melhor definição muscular.'
    }
  ];

  try {
    for (const w of workouts) {
      // Usar COALESCE ou verificar duplicados por título
      const existing = await sql`SELECT id FROM conteudo_treinos WHERE title = ${w.title} LIMIT 1`;
      
      if (existing.length > 0) {
        console.log(`[Pular] "${w.title}" já existe.`);
        continue;
      }

      await sql`
        INSERT INTO conteudo_treinos 
          (title, calories, minutes, image_url, specialty, level, description, exercicios, ativo)
        VALUES 
          (${w.title}, ${w.calories}, ${w.minutes}, ${w.image_url}, ${w.specialty}, ${w.level}, ${w.description}, '[]', TRUE)
      `;
      console.log(`[Sucesso] "${w.title}" inserido.`);
    }

    console.log('✅ Migração concluída com sucesso!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Erro na migração:', error);
    process.exit(1);
  }
}

migrate();
