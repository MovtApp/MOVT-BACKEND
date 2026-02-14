require("dotenv").config();
const express = require("express");
const cors = require("cors");
const postgres = require("postgres");
const bcrypt = require("bcrypt");
const { v4: uuidv4 } = require("uuid");
const nodemailer = require("nodemailer");
const crypto = require("crypto");
const multer = require("multer");
const sharp = require("sharp");
const { createClient } = require("@supabase/supabase-js");
const Stripe = require('stripe');
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const stripe = stripeSecretKey ? Stripe(stripeSecretKey) : null;

if (!stripe) {
  console.warn("⚠️  Aviso: STRIPE_SECRET_KEY não encontrada. As rotas de pagamento não funcionarão.");
}

const databaseUrl = process.env.DATABASE_URL;
const emailUser = process.env.EMAIL_USER;
const emailPass = process.env.EMAIL_PASS;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Inicializar cliente Supabase para Storage e Admin API
const supabase = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
  : null;

// Bucket de avatares no Supabase Storage
const AVATAR_BUCKET = process.env.SUPABASE_AVATAR_BUCKET || "avatars";

const sql = postgres(databaseUrl, {
  ssl: {
    rejectUnauthorized: false
  },
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
  onnotice: () => { },
  onclose: () => {
    // Silencioso por padrão
  }
});

// Inicializaçáo do Banco - Garantir colunas necessárias
async function initDb() {
  try {
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS location TEXT DEFAULT 'São Paulo'`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS job_title TEXT DEFAULT 'Entusiasta Fitness'`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT NULL`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`;

    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS cref TEXT DEFAULT NULL`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS formacao TEXT DEFAULT NULL`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS verificado BOOLEAN DEFAULT FALSE`;

    // Garantir tabela de posts
    await sql`CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      id_us INTEGER REFERENCES usuarios(id_us) ON DELETE CASCADE,
      image_url TEXT NOT NULL,
      legenda TEXT,
      tipo TEXT DEFAULT 'POST',
      likes_count INTEGER DEFAULT 0,
      comments_count INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`;

    // Garantir tabela de follows e migrar se necessário
    await sql`CREATE TABLE IF NOT EXISTS follows (
      id SERIAL PRIMARY KEY,
      follower_user_id INTEGER REFERENCES usuarios(id_us) ON DELETE CASCADE,
      followed_user_id INTEGER REFERENCES usuarios(id_us) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(follower_user_id, followed_user_id)
    )`;

    // Se a tabela ja existia com trainer_id, renomear para followed_user_id
    try {
      await sql`
        DO $$ 
        BEGIN 
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='follows' AND column_name='trainer_id') THEN
            ALTER TABLE follows RENAME COLUMN trainer_id TO followed_user_id;
          END IF;
        END $$;
      `;
    } catch (migrateErr) {
      console.log("Aviso: Falha ao renomear coluna ou coluna ja renomeada.");
    }

    await sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS last_sender_id TEXT DEFAULT NULL`;

    // Garantir coluna de especialidades para usuários (principalmente personals)
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS especialidades TEXT[] DEFAULT '{}'`;

    // Garantir tabela de treinos (usando nome exclusivo para evitar conflito)
    await sql`CREATE TABLE IF NOT EXISTS conteudo_treinos (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      calories TEXT,
      minutes TEXT,
      image_url TEXT,
      specialty TEXT,
      level TEXT DEFAULT 'Iniciante',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`;

    // Inserir treinos padrão se a tabela estiver vazia
    const [treinosCount] = await sql`SELECT count(*) FROM conteudo_treinos`;
    if (parseInt(treinosCount.count) === 0) {
      await sql`
        INSERT INTO conteudo_treinos (title, calories, minutes, image_url, specialty) VALUES
        ('Agachamento Pesado', '180 - 250 Kcal', '15 min', 'https://res.cloudinary.com/ditlmzgrh/image/upload/v1757229915/image_71_jntmsv.jpg', 'Musculação'),
        ('Supino Reto', '150 - 200 Kcal', '12 min', 'https://res.cloudinary.com/ditlmzgrh/image/upload/v1757229915/image_txncpp.jpg', 'Musculação'),
        ('HIIT Queima Gordura', '300 - 450 Kcal', '20 min', 'https://res.cloudinary.com/ditlmzgrh/image/upload/v1757229918/image111_gu6iim.jpg', 'HIIT'),
        ('Funcional Core', '200 - 300 Kcal', '15 min', 'https://res.cloudinary.com/ditlmzgrh/image/upload/v1757229918/image_73_co9eqf.jpg', 'Treinamento Funcional'),
        ('Pilates Postural', '100 - 150 Kcal', '30 min', 'https://res.cloudinary.com/ditlmzgrh/image/upload/v1757229918/image_75_drh4vh.jpg', 'Pilates'),
        ('Deadlift Progressiva', '200 - 350 Kcal', '15 min', 'https://res.cloudinary.com/ditlmzgrh/image/upload/v1757229918/image111_gu6iim.jpg', 'Hipertrofia')
      `;
    }

    // Tabela para avaliações de treinos concluídos
    await sql`CREATE TABLE IF NOT EXISTS avaliacoes_treinos (
      id SERIAL PRIMARY KEY,
      id_agendamento INTEGER NOT NULL,
      id_autor TEXT NOT NULL,
      id_destino TEXT NOT NULL,
      nota_profissional INTEGER NOT NULL,
      nota_treino INTEGER NOT NULL,
      comentario TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`;

    console.log("✅ Banco de dados sincronizado.");
  } catch (err) {
    console.error("❌ Erro ao sincronizar banco de dados:", err);
  }
}
initDb();

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: emailUser,
    pass: emailPass,
  },
  tls: {
    rejectUnauthorized: false,
  },
});

// Funçáo auxiliar para resolver ID de usuário (pode ser INTEGER ou UUID)
async function resolveUserId(id) {
  if (!id) return null;

  // Se for um UUID (contém hífens), busca no mapeamento
  if (typeof id === 'string' && id.includes('-')) {
    try {
      const [mapping] = await sql`
        SELECT id_us FROM user_id_mapping WHERE auth_user_id = ${id}
      `;
      if (mapping) return mapping.id_us;
    } catch (err) {
      console.error("Erro ao resolver UUID para id_us:", err);
    }
  }

  // Caso contrário, tenta converter para inteiro
  const numericId = parseInt(id, 10);
  return isNaN(numericId) ? null : numericId;
}

// Funçáo auxiliar para obter o UUID do Supabase Auth a partir do ID do seu banco
async function getUserAuthId(userId) {
  console.log(`[getUserAuthId] Buscando mapeamento para usuário ${userId}...`);
  try {
    const { data, error } = await supabase
      .from('user_id_mapping')
      .select('auth_user_id')
      .eq('id_us', userId)
      .single();

    if (error) {
      console.log(`[getUserAuthId] Aviso: Não encontrei mapeamento direto: ${error.message}`);
    } else if (data) {
      console.log(`[getUserAuthId] Mapeamento encontrado: ${data.auth_user_id}`);
      return data;
    }
  } catch (err) {
    console.error("[getUserAuthId] Erro ao buscar no Supabase:", err.message);
  }

  console.log(`[getUserAuthId] Tentando obter e-mail para usuário ${userId}...`);
  try {
    const [user] = await sql`
      SELECT id_us, email, nome FROM usuarios WHERE id_us = ${userId}
    `;

    if (user && user.email) {
      console.log(`[getUserAuthId] Usuário encontrado: ${user.email}. Garantindo no Supabase Auth...`);
      return await ensureUserInSupabaseAuth(user);
    }
  } catch (dbError) {
    console.error(`[getUserAuthId] Erro no banco: ${dbError.message}`);
  }

  return null;
}

// Funçáo para garantir que o usuá¡rio existe no Supabase Auth e retornar seu UUID
async function ensureUserInSupabaseAuth(user) {
  const { data: existingUser, error: searchError } = await supabase
    .from('user_id_mapping')
    .select('auth_user_id')
    .eq('id_us', user.id_us)
    .single();

  if (!searchError && existingUser) {
    // Usuá¡rio já¡ está¡ mapeado
    return existingUser;
  }

  // Tenta encontrar o usuá¡rio no Supabase Auth pelo email
  const { data: supabaseUsers, error: authError } = await supabase
    .from('auth.users')
    .select('id')
    .eq('email', user.email)
    .limit(1);

  if (!authError && supabaseUsers && supabaseUsers.length > 0) {
    // Usuá¡rio encontrado no Supabase Auth, criar mapeamento
    const authUserId = supabaseUsers[0].id;

    const { error: insertError } = await supabase
      .from('user_id_mapping')
      .insert({
        id_us: user.id_us,
        auth_user_id: authUserId
      });

    if (insertError) {
      console.error("Erro ao inserir mapeamento de usuá¡rio:", insertError);
    } else {
      console.log(`Mapeamento criado para usuá¡rio ${user.id_us} -> ${authUserId}`);
    }

    return { auth_user_id: authUserId };
  }

  // Se o usuá¡rio ná£o existe no Supabase Auth, precisamos criá¡-lo
  // Vamos usar o Admin API do Supabase para criar o usuá¡rio
  console.log(`Usuá¡rio com email ${user.email} ná£o encontrado no Supabase Auth. Criando usuá¡rio...`);

  try {
    // Criar o usuá¡rio no Supabase Auth usando o Admin API
    const { data: newUser, error: createUserError } = await supabase.auth.admin.createUser({
      email: user.email,
      email_confirm: true, // Confirmar o email automaticamente
      password: null, // Ná£o definir senha, pois o usuá¡rio já¡ existe no seu sistema
    });

    if (createUserError) {
      console.error("Erro ao criar usuá¡rio no Supabase Auth:", createUserError);
      // Se ná£o conseguir criar via Admin API, vamos gerar um UUID temporá¡rio
      const generatedUuid = generateUuidForUser(user.id_us, user.email);

      const { error: insertError } = await supabase
        .from('user_id_mapping')
        .insert({
          id_us: user.id_us,
          auth_user_id: generatedUuid
        });

      if (insertError) {
        console.error("Erro ao inserir mapeamento de usuá¡rio:", insertError);
        return null;
      }

      console.log(`Mapeamento temporá¡rio criado para usuá¡rio ${user.id_us} -> ${generatedUuid}`);
      return { auth_user_id: generatedUuid };
    }

    // Usuá¡rio criado com sucesso, criar o mapeamento
    const { error: insertError } = await supabase
      .from('user_id_mapping')
      .insert({
        id_us: user.id_us,
        auth_user_id: data.user.id
      });

    if (insertError) {
      console.error("Erro ao inserir mapeamento de usuá¡rio:", insertError);
      return null;
    }

    console.log(`Usuá¡rio criado e mapeamento realizado para ${user.id_us} -> ${data.user.id}`);
    return { auth_user_id: data.user.id };
  } catch (adminError) {
    console.error("Erro ao usar Admin API para criar usuá¡rio:", adminError);
    // Em caso de erro, gerar UUID temporá¡rio como fallback
    const generatedUuid = generateUuidForUser(user.id_us, user.email);

    const { error: insertError } = await supabase
      .from('user_id_mapping')
      .insert({
        id_us: user.id_us,
        auth_user_id: generatedUuid
      });

    if (insertError) {
      console.error("Erro ao inserir mapeamento de usuá¡rio:", insertError);
      return null;
    }

    console.log(`Mapeamento temporá¡rio criado para usuá¡rio ${user.id_us} -> ${generatedUuid}`);
    return { auth_user_id: generatedUuid };
  }
}

// Funçáo auxiliar para gerar UUID baseado no ID do usuá¡rio e email
function generateUuidForUser(userId, email) {
  // Esta á© uma implementaçáo simplificada
  // Em produçáo, vocáª deve usar uma biblioteca adequada para gerar UUIDs
  const crypto = require('crypto');
  const hash = crypto.createHash('md5').update(`${userId}-${email}`).digest('hex');
  return `${hash.substring(0, 8)}-${hash.substring(8, 12)}-${hash.substring(12, 16)}-${hash.substring(16, 20)}-${hash.substring(20, 32)}`;
}

function generateVerificationCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function getGravatarUrl(email) {
  const normalizedEmail = (email || "").trim().toLowerCase();
  if (!normalizedEmail) return null;
  const hash = crypto.createHash("md5").update(normalizedEmail).digest("hex");
  return `https://www.gravatar.com/avatar/${hash}?d=identicon&s=200`;
}

async function sendVerificationEmail(toEmail, verificationCode) {
  const mailOptions = {
    from: emailUser,
    to: toEmail,
    subject: "Verificaçáo de E-mail para MOVT App",
    html: `
      <p>Olá¡,</p>
      <p>Obrigado por se registrar no MOVT App!</p>
      <p>Seu cá³digo de verificaçáo á©:</p>
      <h3>${verificationCode}</h3>
      <p>Este cá³digo expira em 15 minutos.</p>
      <p>Se vocáª ná£o solicitou esta verificaçáo, por favor, ignore este e-mail.</p>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`E-mail de verificaçáo enviado para ${toEmail}`);
    return true;
  } catch (error) {
    console.error(
      `Erro ao enviar e-mail de verificaçáo para ${toEmail}:`,
      error,
    );
    return false;
  }
}

// Encryption/Decryption functions for message content
let ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '6f9a2b8c4d7e1f3a5b0c9d8e7f6a5b4c'; // 32 bytes fallback
if (typeof ENCRYPTION_KEY === 'string' && ENCRYPTION_KEY.length !== 32) {
  // Ajustar para 32 bytes se necessário (pad ou truncate)
  ENCRYPTION_KEY = ENCRYPTION_KEY.padEnd(32, '0').substring(0, 32);
}
const IV_LENGTH = 16; // For AES-256-CBC, this is always 16

function encryptMessage(text) {
  if (!text) return text;

  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  } catch (error) {
    console.error('Encryption error:', error);
    return text; // Return original text if encryption fails
  }
}

function decryptMessage(encryptedText) {
  if (!encryptedText) return encryptedText;

  try {
    const parts = encryptedText.split(':');
    if (parts.length !== 2) {
      return encryptedText; // Return as is if not properly formatted
    }

    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    console.error('Decryption error:', error);
    return encryptedText; // Return original if decryption fails
  }
}

const app = express();
const port = process.env.PORT || 3000;

// Configuração dinâmica da URL Base do Backend
const BASE_URL = process.env.APP_URL || (process.env.NODE_ENV === 'production'
  ? 'https://movt-backend.vercel.app'
  : `http://localhost:${port}`);

console.log(`📡 URL Base configurada: ${BASE_URL}`);

app.use(express.json());
app.use(cors());

// Rota raiz para confirmar que o servidor está online
app.get("/", (req, res) => {
  res.json({
    status: "online",
    message: "MOVT API Backend está rodando!",
    environment: process.env.NODE_ENV || "development",
    version: "1.0.0"
  });
});

// Alias para /api
app.get("/api", (req, res) => {
  res.json({ message: "Use as rotas específicas da API (ex: /api/academias, /api/user)" });
});

// Middleware de verificaçáo de sessá£o
function verifyToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res
      .status(403)
      .json({ message: "Token de sessão não fornecido ou formato inválido." });
  }

  const sessionId = authHeader.split(" ")[1];

  // Testar conexá£o com o banco de dados antes de tentar a consulta
  sql`SELECT 1`
    .then(() => {
      return sql`SELECT id_us FROM usuarios WHERE session_id = ${sessionId}`;
    })
    .then((users) => {
      if (users.length === 0) {
        return res
          .status(401)
          .json({ message: "Token de sessão inválido ou expirado." });
      }

      // Armazenar o ID do usuá¡rio do banco principal
      req.userId = users[0].id_us;

      // Para operaá§áµes de chat, precisamos do UUID do Supabase Auth
      // Vamos tentar encontrar o UUID correspondente
      // Por enquanto, vamos usar um UUID fixo para testes, mas idealmente
      // vocáª precisaria ter uma tabela de mapeamento ou usar o Supabase Auth diretamente
      next();
    })
    .catch((error) => {
      console.error("Erro na verificação do token de sessão:", error);

      // Verificar se á© um erro de conexá£o com o banco de dados
      if (error.message && (error.message.includes('Tenant or user not found') || error.message.includes('FATAL'))) {
        return res.status(503).json({
          error: "Erro de conexão com o banco de dados. Serviço temporariamente indisponível.",
          details: "O sistema de autenticação está temporariamente indisponível. Tente novamente mais tarde."
        });
      }

      res.status(500).json({
        error: "Erro interno do servidor na verificaçáo do token.",
        details: error.message,
      });
    });
}

// ==================== CONFIGURAá‡áƒO DE UPLOAD DE AVATAR ==================== //

// Configuraçáo do Multer
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const validTypes = ["image/jpeg", "image/png", "image/webp"];
    if (!validTypes.includes(file.mimetype)) {
      return cb(new multer.MulterError("LIMIT_UNEXPECTED_FILE", "avatar"));
    }
    cb(null, true);
  },
});

// Funçáo principal para processar um upload de avatar usando Supabase Storage
async function processAndSaveAvatar(userId, fileBuffer, mimetype) {
  // Verifica se Supabase está¡ configurado
  if (!supabase) {
    throw { code: 500, message: "Supabase Storage ná£o configurado. Verifique as variá¡veis de ambiente." };
  }

  // Validaçáo extra: tipos vá¡lidos
  const validMimeTypes = ["image/jpeg", "image/png", "image/webp"];
  if (!validMimeTypes.includes(mimetype)) {
    throw { code: 422, message: "Formato de imagem ná£o suportado." };
  }

  // Checa dimensáµes má¡ximas (2k x 2k)
  let image;
  try {
    image = sharp(fileBuffer);
    const metadata = await image.metadata();
    if (
      metadata.width > 2000 ||
      metadata.height > 2000
    ) {
      throw { code: 422, message: "A imagem deve ter no má¡ximo 2000x2000 px." };
    }
  } catch (err) {
    if (err.code) throw err;
    throw { code: 400, message: "Arquivo de imagem invá¡lido." };
  }

  // Paths/nomes no Supabase Storage
  const uuid = uuidv4();
  const base = `avatar_${userId}_${uuid}`;
  const ext = mimetype === "image/png" ? "png" : mimetype === "image/webp" ? "webp" : "jpg";

  // Processa as versáµes redimensionadas
  const [originalBuffer, thumb96Buffer, thumb192Buffer, thumb512Buffer] = await Promise.all([
    sharp(fileBuffer).toFormat(ext, { quality: 95 }).toBuffer(),
    sharp(fileBuffer).resize(96, 96).toFormat(ext, { quality: 80 }).toBuffer(),
    sharp(fileBuffer).resize(192, 192).toFormat(ext, { quality: 80 }).toBuffer(),
    sharp(fileBuffer).resize(512, 512).toFormat(ext, { quality: 90 }).toBuffer(),
  ]);

  // Define os caminhos no bucket
  const originalPath = `${userId}/${base}_original.${ext}`;
  const thumb96Path = `${userId}/${base}_96x96.${ext}`;
  const thumb192Path = `${userId}/${base}_192x192.${ext}`;
  const thumb512Path = `${userId}/${base}_512x512.${ext}`;

  // Faz upload de todas as versáµes para o Supabase Storage
  const [originalUpload, thumb96Upload, thumb192Upload, thumb512Upload] = await Promise.all([
    supabase.storage
      .from(AVATAR_BUCKET)
      .upload(originalPath, originalBuffer, {
        contentType: mimetype,
        upsert: true,
      }),
    supabase.storage
      .from(AVATAR_BUCKET)
      .upload(thumb96Path, thumb96Buffer, {
        contentType: mimetype,
        upsert: true,
      }),
    supabase.storage
      .from(AVATAR_BUCKET)
      .upload(thumb192Path, thumb192Buffer, {
        contentType: mimetype,
        upsert: true,
      }),
    supabase.storage
      .from(AVATAR_BUCKET)
      .upload(thumb512Path, thumb512Buffer, {
        contentType: mimetype,
        upsert: true,
      }),
  ]);

  // Verifica erros no upload
  if (originalUpload.error) throw { code: 500, message: `Erro ao fazer upload: ${originalUpload.error.message}` };
  if (thumb96Upload.error) throw { code: 500, message: `Erro ao fazer upload: ${thumb96Upload.error.message}` };
  if (thumb192Upload.error) throw { code: 500, message: `Erro ao fazer upload: ${thumb192Upload.error.message}` };
  if (thumb512Upload.error) throw { code: 500, message: `Erro ao fazer upload: ${thumb512Upload.error.message}` };

  // Obtá©m URLs páºblicas dos arquivos
  const { data: originalUrlData } = supabase.storage
    .from(AVATAR_BUCKET)
    .getPublicUrl(originalPath);

  const { data: thumb96UrlData } = supabase.storage
    .from(AVATAR_BUCKET)
    .getPublicUrl(thumb96Path);

  const { data: thumb192UrlData } = supabase.storage
    .from(AVATAR_BUCKET)
    .getPublicUrl(thumb192Path);

  const { data: thumb512UrlData } = supabase.storage
    .from(AVATAR_BUCKET)
    .getPublicUrl(thumb512Path);

  return {
    original: originalUrlData.publicUrl,
    thumb96: thumb96UrlData.publicUrl,
    thumb192: thumb192UrlData.publicUrl,
    thumb512: thumb512UrlData.publicUrl,
    ext,
  };
}

// Funçáo auxiliar para gerar dados mockados 
function generateMockCaloriesData(timeframe) {
  const now = new Date();
  let data = [];

  switch (timeframe) {
    case "1d":
      data = Array.from({ length: 24 }, (_, i) => {
        const date = new Date(now);
        date.setHours(i, 0, 0, 0);
        return {
          date: date.toISOString(),
          calories: Math.floor(1400 + Math.random() * 600),
          timestamp: date.toISOString(),
        };
      });
      break;

    case "1s":
      data = Array.from({ length: 7 }, (_, i) => {
        const date = new Date(now);
        date.setDate(date.getDate() - (6 - i));
        return {
          date: date.toISOString(),
          calories: Math.floor(1500 + Math.random() * 500),
          timestamp: date.toISOString(),
        };
      });
      break;

    case "1m":
      data = Array.from({ length: 30 }, (_, i) => {
        const date = new Date(now);
        date.setDate(date.getDate() - (29 - i));
        return {
          date: date.toISOString(),
          calories: Math.floor(1400 + Math.random() * 700),
          timestamp: date.toISOString(),
        };
      });
      break;

    case "1a":
      data = Array.from({ length: 12 }, (_, i) => {
        const date = new Date(now);
        date.setMonth(date.getMonth() - (11 - i));
        return {
          date: date.toISOString(),
          calories: Math.floor(1600 + Math.random() * 400),
          timestamp: date.toISOString(),
        };
      });
      break;

    case "Tudo":
      data = Array.from({ length: 60 }, (_, i) => {
        const date = new Date(now);
        date.setDate(date.getDate() - (59 - i));
        return {
          date: date.toISOString(),
          calories: Math.floor(1300 + Math.random() * 800),
          timestamp: date.toISOString(),
        };
      });
      break;
  }

  return data;
}

// ------------------- AUTENTICAá‡áƒO DE USUáRIO --------------------- //

app.post("/api/login", async (req, res) => {

  const { email, senha, sessionId: providedSessionId } = req.body;

  if (!email || !senha) {
    return res.status(400).json({ error: "Email e senha sá£o obrigatá³rios." });
  }

  try {
    // Testar conexá£o com o banco de dados antes de tentar a consulta
    try {
      await sql`SELECT 1`;
    } catch (dbError) {
      console.error("Erro na conexá£o com o banco de dados:", dbError);
      return res.status(503).json({
        error: "Serviá§o de banco de dados temporariamente indisponá­vel.",
        details: dbError.message
      });
    }

    const [user] = await sql`
      SELECT id_us, email, senha, username, nome, session_id, email_verified
      FROM usuarios
      WHERE email = ${email};
    `;

    if (!user) {
      return res
        .status(401)
        .json({ error: "Endereá§o de e-mail incorreto, tente novamente!" });
    }

    const isPasswordValid = await bcrypt.compare(senha, user.senha);

    if (!isPasswordValid) {
      return res
        .status(401)
        .json({ error: "Senha invá¡lida, tente novamente!" });
    }

    if (providedSessionId && providedSessionId !== user.session_id) {
      return res
        .status(401)
        .json({ error: "Token de sessá£o inconsistente ou invá¡lido." });
    }

    console.log(`[LOGIN] Buscando mapeamento Supabase para usuário ID ${user.id_us}...`);
    // Obter o UUID do Supabase Auth para o usuá¡rio
    const userMapping = await getUserAuthId(user.id_us);
    const supabase_uid = userMapping ? userMapping.auth_user_id : null;

    console.log(`✅ [LOGIN] Sucesso: ${email} (UID: ${supabase_uid})`);
    res.status(200).json({
      message: "Login bem-sucedido!",
      user: {
        id: user.id_us,
        nome: user.nome,
        username: user.username,
        email: user.email,
        isVerified: user.email_verified,
        supabase_uid: supabase_uid,
      },
      sessionId: user.session_id,
    });
  } catch (error) {
    console.error("Erro ao autenticar usuá¡rio:", error);

    // Verificar se á© um erro de conexá£o com o banco de dados
    if (error.message && (error.message.includes('Tenant or user not found') || error.message.includes('FATAL'))) {
      return res.status(503).json({
        error: "Erro de conexá£o com o banco de dados. Serviá§o temporariamente indisponá­vel.",
        details: "O sistema de autenticaçáo está¡ temporariamente indisponá­vel. Tente novamente mais tarde."
      });
    }

    res.status(500).json({
      error: "Erro interno do servidor ao autenticar usuá¡rio.",
      details: error.message,
    });
  }
});

app.post("/api/register", async (req, res) => {

  const {
    nome,
    email,
    senha,
    cpf_cnpj,
    data_nascimento,
    telefone,
    tipo_documento,
  } = req.body;

  if (!nome || !email || !senha || !cpf_cnpj || !data_nascimento || !telefone) {
    return res.status(400).json({ error: "Todos os campos sá£o obrigatá³rios." });
  }

  try {
    // Testar conexá£o com o banco de dados antes de tentar a consulta
    try {
      await sql`SELECT 1`;
    } catch (dbError) {
      console.error("Erro na conexá£o com o banco de dados:", dbError);
      return res.status(503).json({
        error: "Serviá§o de banco de dados temporariamente indisponá­vel.",
        details: dbError.message
      });
    }

    let userCpf = null;
    let userCnpj = null;

    if (tipo_documento === "CPF") {
      userCpf = cpf_cnpj;
    } else if (tipo_documento === "CNPJ") {
      userCnpj = cpf_cnpj;
    }

    const conditions = [];
    conditions.push(sql`email = ${email}`);

    if (userCpf !== null) {
      conditions.push(sql`cpf = ${userCpf}`);
    }
    if (userCnpj !== null) {
      conditions.push(sql`cnpj = ${userCnpj}`);
    }

    let whereClause = sql`TRUE`;
    if (conditions.length > 0) {
      whereClause = sql`WHERE ${conditions[0]}`;
      for (let i = 1; i < conditions.length; i++) {
        whereClause = sql`${whereClause} OR ${conditions[i]}`;
      }
    }

    const existingUser = await sql`
      SELECT id_us, email, cpf, cnpj
      FROM usuarios
      ${whereClause}
    `;

    if (existingUser.length > 0) {
      if (existingUser[0].email === email) {
        return res
          .status(409)
          .json({ error: "Este e-mail já¡ está¡ cadastrado." });
      } else if (existingUser[0].cpf === userCpf && userCpf !== null) {
        return res.status(409).json({ error: "Este CPF já¡ está¡ cadastrado." });
      } else if (existingUser[0].cnpj === userCnpj && userCnpj !== null) {
        return res.status(409).json({ error: "Este CNPJ já¡ está¡ cadastrado." });
      } else {
        return res
          .status(409)
          .json({ error: "Erro de unicidade no banco de dados." });
      }
    }

    const hashedPassword = await bcrypt.hash(senha, 10);
    const newSessionId = uuidv4();
    const verificationCode = generateVerificationCode();
    const verificationCodeExpiresAt = new Date(Date.now() + 15 * 60 * 1000);

    const [day, month, year] = data_nascimento.split("/");
    const formattedBirthDate = `${year}-${month}-${day} 00:00:00`;

    const [newUser] = await sql`
      INSERT INTO usuarios (nome, username, email, senha, cpf, cnpj, data_nascimento, telefone, created_at, updated_at, session_id, verification_code, email_verified, verification_code_expires_at)
      VALUES (${nome}, ${email}, ${email}, ${hashedPassword}, ${userCpf}, ${userCnpj}, ${formattedBirthDate}, ${telefone}, NOW(), NOW(), ${newSessionId}, ${verificationCode}, FALSE, ${verificationCodeExpiresAt})
      RETURNING id_us, nome, username, email, cpf, cnpj, data_nascimento, telefone, session_id;
    `;

    const emailSent = await sendVerificationEmail(
      newUser.email,
      verificationCode,
    );
    if (!emailSent) {
      console.warn(
        "Falha ao enviar e-mail de verificaçáo para o novo usuá¡rio.",
      );
    }

    console.log(`✅ Registro realizado: ${email}`);
    res.status(201).json({
      message: "Usuário registrado com sucesso! Verifique seu e-mail.",
      user: newUser,
      sessionId: newSessionId,
    });
  } catch (error) {
    console.error("Erro ao registrar usuá¡rio:", error);

    // Verificar se á© um erro de conexá£o com o banco de dados
    if (error.message && (error.message.includes('Tenant or user not found') || error.message.includes('FATAL'))) {
      return res.status(503).json({
        error: "Erro de conexá£o com o banco de dados. Serviá§o temporariamente indisponá­vel.",
        details: "O sistema de registro está¡ temporariamente indisponá­vel. Tente novamente mais tarde."
      });
    }

    if (error.code === "23505") {
      return res.status(409).json({
        error:
          "Erro de unicidade no banco de dados (e.g., email, CPF ou CNPJ).",
      });
    }
    res.status(500).json({
      error: "Erro interno do servidor ao registrar usuá¡rio.",
      details: error.message,
    });
  }
});

// --------------------- PLANOS E ASSINATURAS (STRIPE) --------------------- //

app.get("/api/plans", async (req, res) => {
  try {
    const products = await stripe.products.list({
      active: true,
      expand: ["data.default_price"],
    });

    const plans = products.data.map(product => {
      const price = product.default_price;
      return {
        id: product.id,
        stripe_product_id: product.id,
        stripe_price_id: price ? price.id : null,
        name: product.name,
        description: product.description,
        price: price ? (price.unit_amount ? price.unit_amount / 100 : 0) : 0,
        currency: price ? price.currency : "brl",
        interval: price && price.recurring ? price.recurring.interval : "limitado",
        billing_scheme: price ? price.billing_scheme : 'per_unit',
        metadata: product.metadata || {}
      };
    });

    plans.sort((a, b) => a.price - b.price);
    res.json(plans);
  } catch (error) {
    console.error("Erro ao buscar planos na Stripe:", error);
    res.status(500).json({ error: "Falha ao buscar planos de assinatura.", details: error.message });
  }
});

app.post("/api/create-checkout-session", verifyToken, async (req, res) => {
  const { priceId, quantity } = req.body;
  const userId = req.userId;

  try {
    const [user] = await sql`SELECT email FROM usuarios WHERE id_us = ${userId}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: quantity || 1,
        },
      ],
      customer_email: user.email,
      success_url: 'https://movt.app/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://movt.app/cancel',
      metadata: {
        userId: String(userId)
      }
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error("Erro ao criar sessão de checkout:", error);
    res.status(500).json({ error: error.message });
  }
});

// --------------------- VERIFICAá‡áƒO DE USUáRIO --------------------- //

app.post("/api/user/send-verification", verifyToken, async (req, res) => {

  const userId = req.userId;

  try {
    const [user] =
      await sql`SELECT email, email_verified FROM usuarios WHERE id_us = ${userId}`;

    if (!user) {
      return res.status(404).json({ error: "Usuá¡rio ná£o encontrado." });
    }
    if (user.email_verified) {
      return res
        .status(400)
        .json({ message: "Seu e-mail já¡ está¡ verificado." });
    }

    const newVerificationCode = generateVerificationCode();
    const newVerificationCodeExpiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await sql`
      UPDATE usuarios
      SET verification_code = ${newVerificationCode},
          verification_code_expires_at = ${newVerificationCodeExpiresAt},
          updated_at = NOW()
      WHERE id_us = ${userId};
    `;

    const emailSent = await sendVerificationEmail(
      user.email,
      newVerificationCode,
    );

    if (emailSent) {
      console.log(`âœ… Cá³digo de verificaçáo enviado: ${user.email}`);
      res.status(200).json({
        message: "Novo cá³digo de verificaçáo enviado para seu e-mail.",
      });
    } else {
      res
        .status(500)
        .json({ error: "Falha ao enviar o e-mail de verificaçáo." });
    }
  } catch (error) {
    console.error("Erro ao reenviar cá³digo de verificaçáo:", error);
    res.status(500).json({
      error: "Erro interno do servidor ao reenviar cá³digo.",
      details: error.message,
    });
  }
});

app.post("/api/user/verify", verifyToken, async (req, res) => {
  const userId = req.userId;
  const { code } = req.body;

  if (!code) {
    return res
      .status(400)
      .json({ error: "Cá³digo de verificaçáo á© obrigatá³rio." });
  }

  try {
    const [user] = await sql`
      SELECT email_verified, verification_code, verification_code_expires_at
      FROM usuarios
      WHERE id_us = ${userId};
    `;

    if (!user) {
      return res.status(404).json({ error: "Usuá¡rio ná£o encontrado." });
    }
    if (user.email_verified) {
      return res
        .status(400)
        .json({ message: "Seu e-mail já¡ está¡ verificado." });
    }
    if (!user.verification_code || user.verification_code !== code) {
      return res.status(400).json({ error: "Cá³digo de verificaçáo invá¡lido." });
    }
    if (
      user.verification_code_expires_at &&
      new Date() > user.verification_code_expires_at
    ) {
      return res
        .status(400)
        .json({ error: "Cá³digo de verificaçáo expirado. Solicite um novo." });
    }

    await sql`
      UPDATE usuarios
      SET email_verified = TRUE,
          verification_code = NULL,
          verification_code_expires_at = NULL,
          updated_at = NOW()
      WHERE id_us = ${userId};
    `;

    res.status(200).json({ message: "E-mail verificado com sucesso!" });
  } catch (error) {
    console.error("Erro ao verificar e-mail:", error);
    res.status(500).json({
      error: "Erro interno do servidor ao verificar e-mail.",
      details: error.message,
    });
  }
});

app.get("/api/user/session-status", verifyToken, async (req, res) => {

  const userId = req.userId;

  try {
    // Testar conexá£o com o banco de dados antes de tentar a consulta
    try {
      await sql`SELECT 1`;
    } catch (dbError) {
      console.error("Erro na conexá£o com o banco de dados:", dbError);
      return res.status(503).json({
        error: "Serviá§o de banco de dados temporariamente indisponá­vel.",
        details: dbError.message
      });
    }

    const [user] = await sql`
      SELECT id_us, email, username, nome, email_verified
      FROM usuarios
      WHERE id_us = ${userId};
    `;

    if (!user) {
      return res
        .status(404)
        .json({ error: "Usuá¡rio ná£o encontrado para a sessá£o ativa." });
    }

    // Obter o UUID do Supabase Auth para o usuá¡rio
    const userMapping = await getUserAuthId(user.id_us);
    const supabase_uid = userMapping ? userMapping.auth_user_id : null;

    res.status(200).json({
      message: "Sessá£o ativa.",
      user: {
        id: user.id_us,
        nome: user.nome,
        username: user.username,
        email: user.email,
        isVerified: user.email_verified,
        supabase_uid: supabase_uid,
      },
    });
  } catch (error) {
    console.error("Erro ao obter status da sessá£o:", error);

    // Verificar se á© um erro de conexá£o com o banco de dados
    if (error.message && (error.message.includes('Tenant or user not found') || error.message.includes('FATAL'))) {
      return res.status(503).json({
        error: "Erro de conexá£o com o banco de dados. Serviá§o temporariamente indisponá­vel.",
        details: "O sistema está¡ temporariamente indisponá­vel. Tente novamente mais tarde."
      });
    }

    res.status(500).json({
      error: "Erro interno do servidor ao obter status da sessá£o.",
      details: error.message,
    });
  }
});

// -------------------------------- UPLOAD DE AVATAR ---------------------------- //

app.put("/api/user/avatar", verifyToken, upload.single("avatar"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Arquivo de avatar ná£o enviado." });
  }
  if (req.file.size > 5 * 1024 * 1024) {
    return res.status(413).json({ error: "Arquivo excede 5MB." });
  }

  const userId = req.userId;

  try {
    // Processar & armazenar as imagens
    const urls = await processAndSaveAvatar(
      userId,
      req.file.buffer,
      req.file.mimetype,
    );

    // Atualizar no banco
    const now = new Date();
    await sql`
        UPDATE usuarios
        SET avatar_url = ${urls.original},
            avatar_thumbnail = ${urls.thumb96},
            avatar_medium = ${urls.thumb192},
            avatar_large = ${urls.thumb512},
            updatedat = ${now}
        WHERE id_us = ${userId}
      `;

    // Recupera perfil resumido para resposta
    const [user] = await sql`
        SELECT id_us, avatar_url, avatar_thumbnail, avatar_medium, avatar_large, updatedat
        FROM usuarios
        WHERE id_us = ${userId}
      `;

    return res.status(200).json({
      success: true,
      data: {
        id: user.id_us,
        photo: user.avatar_url,
        photo_thumbnail: user.avatar_thumbnail,
        photo_medium: user.avatar_medium,
        photo_large: user.avatar_large,
        updatedAt: user.updatedat,
      },
    });
  } catch (err) {
    if (err && (err.code === 422 || err.code === 400)) {
      return res.status(err.code).json({ error: err.message });
    }
    if (err instanceof multer.MulterError) {
      // Limite de tamanho ou tipo invá¡lido
      if (err.code === "LIMIT_FILE_SIZE")
        return res.status(413).json({ error: "Arquivo excede 5MB." });
      if (err.code === "LIMIT_UNEXPECTED_FILE")
        return res
          .status(422)
          .json({ error: "Formato de imagem ná£o suportado." });
      return res.status(400).json({ error: err.message });
    }
    console.error("Erro upload avatar:", err);
    return res.status(500).json({
      error: "Erro interno ao processar avatar.",
      details: err && err.message ? err.message : err,
    });
  }
},
);

// ROTA PARA UPLOAD DE BANNER
app.put("/api/user/banner", verifyToken, upload.single("banner"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Arquivo de banner ná£o enviado." });
  }

  const userId = req.userId;

  try {
    // Processar & armazenar as imagens (reutilizando a lá³gica de avatar, mas em outro campo)
    const urls = await processAndSaveAvatar(
      userId,
      req.file.buffer,
      req.file.mimetype,
    );

    // Atualizar no banco
    const now = new Date();
    await sql`
        UPDATE usuarios
        SET banner_url = ${urls.original},
            updated_at = ${now}
        WHERE id_us = ${userId}
      `;

    return res.status(200).json({
      success: true,
      data: {
        id: userId,
        banner: urls.original,
        updatedAt: now,
      },
    });
  } catch (err) {
    console.error("Erro upload banner:", err);
    return res.status(500).json({
      error: "Erro interno ao processar banner.",
      details: err && err.message ? err.message : err,
    });
  }
});

// ROTA GENá‰RICA: Atualizar um áºnico campo do perfil (username ou email)
app.put("/api/user/update-field", verifyToken, async (req, res) => {
  const userId = req.userId;
  const { field, value } = req.body;

  if (!field || !value) {
    return res.status(400).json({ error: "Informe 'field' e 'value' no corpo da requisiçáo." });
  }

  // Permitir apenas campos controlados
  const allowed = ["username", "email", "nome", "banner_url"];
  if (!allowed.includes(field)) {
    return res.status(400).json({ error: "Campo invá¡lido. Apenas 'username', 'email', 'nome' ou 'banner_url' sá£o permitidos." });
  }

  try {
    const [current] = await sql`SELECT username, email FROM usuarios WHERE id_us = ${userId}`;
    if (!current) return res.status(404).json({ error: "Usuá¡rio ná£o encontrado." });

    const now = new Date();

    // Se ná£o houver alteraçáo no campo solicitado, retorna sem mudaná§as
    if (current[field] === value) {
      return res.status(200).json({ success: true, message: "Nenhuma alteraçáo necessá¡ria.", data: { [field]: value } });
    }

    // Verificaá§áµes de unicidade + atualizaçáo (somente do campo solicitado)
    if (field === "username") {
      const existing = await sql`SELECT id_us FROM usuarios WHERE username = ${value} AND id_us != ${userId}`;
      if (existing.length > 0) {
        return res.status(409).json({ error: "Username já¡ está¡ em uso por outro usuá¡rio." });
      }

      // Atualiza somente o username; NáƒO altera/zera a coluna email
      await sql`
        UPDATE usuarios
        SET username = ${value}, updated_at = ${now}
        WHERE id_us = ${userId}
      `;
    }

    if (field === "nome") {
      await sql`
        UPDATE usuarios
        SET nome = ${value}, updated_at = ${now}
        WHERE id_us = ${userId}
      `;
    }

    if (field === "email") {
      const existing = await sql`SELECT id_us FROM usuarios WHERE email = ${value} AND id_us != ${userId}`;
      if (existing.length > 0) {
        return res.status(409).json({ error: "E-mail já¡ está¡ em uso por outro usuá¡rio." });
      }

      const verificationCode = generateVerificationCode();
      const verificationExpiresAt = new Date(Date.now() + 15 * 60 * 1000);

      // Atualiza somente o email; NáƒO altera/zera a coluna username
      await sql`
        UPDATE usuarios
        SET email = ${value}, email_verified = FALSE, verification_code = ${verificationCode}, verification_code_expires_at = ${verificationExpiresAt}, updatedat = ${now}
        WHERE id_us = ${userId}
      `;

      // Tenta enviar e-mail (ná£o bloqueante)
      try {
        await sendVerificationEmail(value, verificationCode);
      } catch (err) {
        console.warn("Falha ao enviar e-mail de verificaçáo apá³s alteraçáo de e-mail (update-field):", err);
      }
    }

    const [updated] = await sql`SELECT id_us, username, email, email_verified FROM usuarios WHERE id_us = ${userId}`;

    return res.status(200).json({
      success: true, data: {
        id: updated.id_us,
        username: updated.username,
        email: updated.email,
        isVerified: updated.email_verified,
      }
    });
  } catch (error) {
    console.error("Erro na rota update-field:", error);
    return res.status(500).json({ error: "Erro interno ao atualizar campo.", details: error.message });
  }
});

// ------------------- ROTAS DE TRAINERS / BUSCAS / UPLOADS ------------------ //

// Lista de trainers (basic, defensivo - retorna usuá¡rios como trainers quando aplicá¡vel) âœ…
app.get("/api/trainers", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const offset = parseInt(req.query.offset) || 0;
    const q = req.query.q && req.query.q.trim();

    // Detecta se a coluna `role` existe (para usar filtro direto e indexado)
    const [colCheck] = await sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'usuarios' AND column_name = 'role'
    `;
    const hasRoleCol = !!colCheck;

    // Se houver token, tentamos obter o role do requester (permitir personalizaá§áµes)
    let requesterRole = null;
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const sessionId = authHeader.split(' ')[1];
      const [r] = await sql`SELECT id_us, role FROM usuarios WHERE session_id = ${sessionId}`;
      if (r) requesterRole = r.role || null;
    }

    if (hasRoleCol) {
      // Usar a coluna role (mais performá¡tico quando indexado)
      if (q) {
        const pattern = `%${q}%`;
        const data = await sql`
          SELECT id_us AS id, nome AS name, username, avatar_url, role
          FROM usuarios
          WHERE role = 'trainer' AND (username ILIKE ${pattern} OR nome ILIKE ${pattern})
          ORDER BY nome
          LIMIT ${limit} OFFSET ${offset}
        `;
        const [{ count } = { count: null }] = await sql`
          SELECT count(*) FROM usuarios WHERE role = 'trainer' AND (username ILIKE ${pattern} OR nome ILIKE ${pattern})
        `;
        return res.status(200).json({ data, meta: { total: parseInt(count, 10) || data.length, limit, offset } });
      }

      const data = await sql`
        SELECT id_us AS id, nome AS name, username, avatar_url, role
        FROM usuarios
        WHERE role = 'trainer'
        ORDER BY nome
        LIMIT ${limit} OFFSET ${offset}
      `;
      const [{ count } = { count: null }] = await sql`SELECT count(*) FROM usuarios WHERE role = 'trainer'`;
      return res.status(200).json({ data, meta: { total: parseInt(count, 10) || data.length, limit, offset } });
    }

    // Fallback: inferir trainers pelo tipo_documento = 'CNPJ' ou por presená§a em trainer_posts
    if (q) {
      const pattern = `%${q}%`;
      const data = await sql`
        SELECT DISTINCT u.id_us AS id, u.nome AS name, u.username, u.avatar_url,
          CASE WHEN tp.trainer_id IS NOT NULL OR u.tipo_documento = 'CNPJ' THEN 'trainer' ELSE
            CASE WHEN u.tipo_documento = 'CNPJ' THEN 'trainer' ELSE 'client_pf' END
          END AS role
        FROM usuarios u
        LEFT JOIN trainer_posts tp ON tp.trainer_id = u.id_us
        WHERE (u.username ILIKE ${pattern} OR u.nome ILIKE ${pattern})
        ORDER BY u.nome
        LIMIT ${limit} OFFSET ${offset}
      `;
      return res.status(200).json({ data, meta: { total: data.length, limit, offset } });
    }

    const data = await sql`
      SELECT DISTINCT u.id_us AS id, u.nome AS name, u.username, u.avatar_url,
        CASE WHEN tp.trainer_id IS NOT NULL OR u.tipo_documento = 'CNPJ' THEN 'trainer' ELSE
          CASE WHEN u.tipo_documento = 'CNPJ' THEN 'trainer' ELSE 'client_pf' END
        END AS role
      FROM usuarios u
      LEFT JOIN trainer_posts tp ON tp.trainer_id = u.id_us
      ORDER BY u.nome
      LIMIT ${limit} OFFSET ${offset}
    `;
    return res.status(200).json({ data, meta: { total: data.length, limit, offset } });
  } catch (err) {
    console.error("Erro em GET /api/trainers:", err);
    return res.status(500).json({ error: "Erro interno ao listar trainers." });
  }
});

// Detalhe de um trainer (busca por id) âœ…
app.get("/api/trainers/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "ID inválido." });
  try {
    // Busca dados básicos e de regularização do usuário
    const [user] = await sql`
      SELECT id_us AS id, nome AS name, username, avatar_url, banner_url, cref, formacao, verificado, bio, location
      FROM usuarios
      WHERE id_us = ${id}
      LIMIT 1
    `;

    if (!user) return res.status(404).json({ error: "Trainer não encontrado." });

    // Busca perfil profissional
    const [profile] = await sql`
      SELECT descricao AS description, experiencia_anos AS "experienceYears", especialidades
      FROM personal_profiles
      WHERE id_trainer = ${id}
      LIMIT 1
    `;

    // Busca contagem de agendamentos reais
    const [{ count: agendamentosCount }] = await sql`
      SELECT count(*)::int FROM agendamentos 
      WHERE id_trainer = ${id} OR id_pj = ${id}
    `;

    // Busca contagem e média de avaliações
    const [{ count: avaliacoesCount }] = await sql`
      SELECT count(*)::int FROM avaliacoes 
      WHERE id_pj = ${id}
    `;

    // Busca endereço da academia vinculada
    const [gym] = await sql`
      SELECT a.id_academia, a.nome, a.endereco_completo, a.rua, a.numero, a.bairro, a.cidade, a.estado
      FROM gym_trainers gt
      JOIN academias a ON gt.gym_id = a.id_academia
      WHERE gt.personal_id = ${id} AND gt.status = 'active'
      LIMIT 1
    `;

    const trainerData = {
      ...user,
      description: profile?.description || user.bio || "Personal Trainer",
      experienceYears: profile?.experienceYears || 0,
      especialidades: profile?.especialidades || [],
      agendamentosCount: agendamentosCount || 0,
      avaliacoesCount: avaliacoesCount || 0,
      verificado: user.verificado || false,
      cref: user.cref || "Não informado",
      formacao: user.formacao || "Não informada",
      gym: gym || null,
      address: gym
        ? `${gym.rua}, ${gym.numero}, ${gym.bairro}, ${gym.cidade} - ${gym.estado}`
        : (user.location || "Atendimento domiciliar / Online")
    };

    console.log(`[DEBUG] Trainer ${id} address:`, trainerData.address, 'Gym:', !!gym);

    return res.status(200).json({ data: trainerData });
  } catch (err) {
    console.error("Erro em GET /api/trainers/:id", err);
    return res.status(500).json({ error: "Erro interno ao obter trainer." });
  }
});

// Lista de posts do trainer (se existir tabela trainer_posts) âœ…
app.get("/api/trainers/:id/posts", async (req, res) => {
  const trainerId = req.params.id;
  const limit = parseInt(req.query.limit) || 10;
  const offset = parseInt(req.query.offset) || 0;
  try {
    const [{ exists }] = await sql`SELECT to_regclass('public.trainer_posts') IS NOT NULL AS exists`;
    if (!exists) return res.status(200).json({ data: [], meta: { total: 0, limit, offset } });

    const data = await sql`
      SELECT id, trainer_id AS trainerId, image_url AS imageUrl, alt, created_at
      FROM trainer_posts
      WHERE trainer_id = ${trainerId}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    const [{ count } = { count: null }] = await sql`SELECT count(*) FROM trainer_posts WHERE trainer_id = ${trainerId}`;
    return res.status(200).json({ data, meta: { total: parseInt(count, 10) || data.length, limit, offset } });
  } catch (err) {
    console.error("Erro em GET /api/trainers/:id/posts", err);
    return res.status(500).json({ error: "Erro interno ao listar posts do trainer." });
  }
});

// GET: List personals with complete profile data (usuarios + personal_profiles) âœ…
app.get("/api/personals", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const offset = parseInt(req.query.offset) || 0;
    const q = req.query.q && req.query.q.trim();
    const gymId = req.query.gymId ? parseInt(req.query.gymId) : null;

    // Check if personal_profiles table exists
    const [{ exists }] = await sql`SELECT to_regclass('public.personal_profiles') IS NOT NULL AS exists`;
    if (!exists) {
      return res.status(200).json({ data: [], meta: { total: 0, limit, offset } });
    }

    let data;
    let totalCount;

    if (gymId) {
      // Filtrar personais vinculados a uma academia específica
      if (q) {
        const pattern = `%${q}%`;
        data = await sql`
          SELECT
            u.id_us AS id,
            u.nome AS name,
            u.username,
            u.avatar_url AS "avatarUrl",
            u.email,
            u.telefone,
            pp.descricao AS description,
            pp.experiencia_anos AS "experienceYears",
            pp.especialidades,
            pp.rating,
            pp.total_avaliacoes AS "totalRatings",
            pp.createdat,
            pp.updatedat
          FROM usuarios u
          JOIN gym_trainers gt ON u.id_us = gt.personal_id
          LEFT JOIN personal_profiles pp ON u.id_us = pp.id_trainer
          WHERE (u.role = 'personal' OR u.role = 'trainer')
            AND gt.gym_id = ${gymId}
            AND gt.status = 'active'
            AND (u.username ILIKE ${pattern} OR u.nome ILIKE ${pattern})
          ORDER BY u.nome
          LIMIT ${limit} OFFSET ${offset}
        `;
        const [{ count }] = await sql`
          SELECT count(*) 
          FROM usuarios u
          JOIN gym_trainers gt ON u.id_us = gt.personal_id
          WHERE (u.role = 'personal' OR u.role = 'trainer')
            AND gt.gym_id = ${gymId}
            AND gt.status = 'active'
            AND (u.username ILIKE ${pattern} OR u.nome ILIKE ${pattern})
        `;
        totalCount = count;
      } else {
        data = await sql`
          SELECT
            u.id_us AS id,
            u.nome AS name,
            u.username,
            u.avatar_url AS "avatarUrl",
            u.email,
            u.telefone,
            pp.descricao AS description,
            pp.experiencia_anos AS "experienceYears",
            pp.especialidades,
            pp.rating,
            pp.total_avaliacoes AS "totalRatings",
            pp.createdat,
            pp.updatedat
          FROM usuarios u
          JOIN gym_trainers gt ON u.id_us = gt.personal_id
          LEFT JOIN personal_profiles pp ON u.id_us = pp.id_trainer
          WHERE (u.role = 'personal' OR u.role = 'trainer')
            AND gt.gym_id = ${gymId}
            AND gt.status = 'active'
          ORDER BY u.nome
          LIMIT ${limit} OFFSET ${offset}
        `;
        const [{ count }] = await sql`
          SELECT count(*) 
          FROM usuarios u
          JOIN gym_trainers gt ON u.id_us = gt.personal_id
          WHERE (u.role = 'personal' OR u.role = 'trainer')
            AND gt.gym_id = ${gymId}
            AND gt.status = 'active'
        `;
        totalCount = count;
      }
    } else {
      // Comportamento original: listar todos os personals
      if (q) {
        const pattern = `%${q}%`;
        data = await sql`
          SELECT
            u.id_us AS id,
            u.nome AS name,
            u.username,
            u.avatar_url AS "avatarUrl",
            u.email,
            u.telefone,
            pp.descricao AS description,
            pp.experiencia_anos AS "experienceYears",
            pp.especialidades,
            pp.rating,
            pp.total_avaliacoes AS "totalRatings",
            pp.createdat,
            pp.updatedat
          FROM usuarios u
          LEFT JOIN personal_profiles pp ON u.id_us = pp.id_trainer
          WHERE (u.role = 'personal' OR u.role = 'trainer') AND (u.username ILIKE ${pattern} OR u.nome ILIKE ${pattern})
          ORDER BY u.nome
          LIMIT ${limit} OFFSET ${offset}
        `;
        const [{ count }] = await sql`
          SELECT count(*) FROM usuarios WHERE (role = 'personal' OR role = 'trainer') AND (username ILIKE ${pattern} OR nome ILIKE ${pattern})
        `;
        totalCount = count;
      } else {
        data = await sql`
          SELECT
            u.id_us AS id,
            u.nome AS name,
            u.username,
            u.avatar_url AS "avatarUrl",
            u.email,
            u.telefone,
            pp.descricao AS description,
            pp.experiencia_anos AS "experienceYears",
            pp.especialidades,
            pp.rating,
            pp.total_avaliacoes AS "totalRatings",
            pp.createdat,
            pp.updatedat
          FROM usuarios u
          LEFT JOIN personal_profiles pp ON u.id_us = pp.id_trainer
          WHERE (u.role = 'personal' OR u.role = 'trainer')
          ORDER BY u.nome
          LIMIT ${limit} OFFSET ${offset}
        `;
        const [{ count }] = await sql`SELECT count(*) FROM usuarios WHERE (role = 'personal' OR role = 'trainer')`;
        totalCount = count;
      }
    }

    return res.status(200).json({
      data,
      meta: {
        total: parseInt(totalCount, 10) || data.length,
        limit,
        offset
      }
    });
  } catch (err) {
    console.error("Erro em GET /api/personals:", err);
    return res.status(500).json({ error: "Erro interno ao listar personals." });
  }
});

// Upload de cover/avatar para um trainer (processa e retorna URLs; NáƒO grava em colunas desconhecidas)
app.put("/api/trainers/:id/cover", verifyToken, upload.single("cover"), async (req, res) => {
  const trainerId = req.params.id;
  // Permissá£o: apenas o prá³prio trainer ou admin pode atualizar
  if (String(req.userId) !== String(trainerId)) {
    // se tiver roles/admin, aqui deveria verificar; por enquanto bloqueia
    return res.status(403).json({ error: "Acesso negado. Apenas o dono pode atualizar a cover." });
  }

  if (!req.file) return res.status(400).json({ error: "Arquivo cover ná£o enviado." });

  try {
    // Reutiliza processamento gená©rico (poderia ter funçáo prá³pria para cover)
    const urls = await processAndSaveAvatar(trainerId, req.file.buffer, req.file.mimetype);
    // Retorna URLs geradas; a gravaçáo em DB fica a critá©rio do backend (schema)
    return res.status(200).json({ success: true, data: { coverUrl: urls.original, coverThumb: urls.thumb192, coverLarge: urls.thumb512 } });
  } catch (err) {
    console.error("Erro em PUT /api/trainers/:id/cover", err);
    return res.status(500).json({ error: "Erro ao processar cover." });
  }
});

app.put("/api/trainers/:id/avatar", verifyToken, upload.single("avatar"), async (req, res) => {
  const trainerId = req.params.id;
  if (String(req.userId) !== String(trainerId)) {
    return res.status(403).json({ error: "Acesso negado. Apenas o dono pode atualizar o avatar." });
  }
  if (!req.file) return res.status(400).json({ error: "Arquivo avatar ná£o enviado." });
  try {
    const urls = await processAndSaveAvatar(trainerId, req.file.buffer, req.file.mimetype);
    return res.status(200).json({ success: true, data: { avatarUrl: urls.original, avatarThumb: urls.thumb96, avatarMedium: urls.thumb192, avatarLarge: urls.thumb512 } });
  } catch (err) {
    console.error("Erro em PUT /api/trainers/:id/avatar", err);
    return res.status(500).json({ error: "Erro ao processar avatar do trainer." });
  }
});

// Follow / Unfollow (sá³ se tabela 'follows' existir)
app.post("/api/trainers/:id/follow", verifyToken, async (req, res) => {
  const trainerId = req.params.id;
  const userId = req.userId;
  try {
    // Validaçáo de entrada
    if (!trainerId || isNaN(parseInt(trainerId, 10))) {
      return res.status(400).json({ error: "ID do trainer invá¡lido." });
    }

    const [{ exists }] = await sql`SELECT to_regclass('public.follows') IS NOT NULL AS exists`;
    if (!exists) return res.status(501).json({ error: "Tabela 'follows' ná£o instalada no banco. Implementaçáo pendente." });

    // Verificar se o trainer existe antes de criar o follow
    const trainerExists = await sql`SELECT id_us FROM usuarios WHERE id_us = ${parseInt(trainerId, 10)} AND (role = 'trainer' OR role = 'personal')`;
    if (!trainerExists || trainerExists.length === 0) {
      return res.status(404).json({ error: "Trainer ná£o encontrado." });
    }

    // Verificar se o usuá¡rio ná£o está¡ tentando seguir a si mesmo
    if (parseInt(trainerId, 10) === userId) {
      return res.status(400).json({ error: "Vocáª ná£o pode seguir a si mesmo." });
    }

    // Insere ou ignora (supondo constraint unique)
    await sql`
      INSERT INTO follows (follower_user_id, trainer_id, created_at)
      VALUES (${userId}, ${parseInt(trainerId, 10)}, CURRENT_TIMESTAMP)
      ON CONFLICT (follower_user_id, trainer_id) DO NOTHING
    `;
    return res.status(200).json({ success: true, following: true });
  } catch (err) {
    console.error("Erro em POST /api/trainers/:id/follow", err);
    return res.status(500).json({ error: "Erro interno ao seguir trainer." });
  }
});

app.delete("/api/trainers/:id/follow", verifyToken, async (req, res) => {
  const trainerId = req.params.id;
  const userId = req.userId;
  try {
    // Validaçáo de entrada
    if (!trainerId || isNaN(parseInt(trainerId, 10))) {
      return res.status(400).json({ error: "ID do trainer invá¡lido." });
    }

    const [{ exists }] = await sql`SELECT to_regclass('public.follows') IS NOT NULL AS exists`;
    if (!exists) return res.status(501).json({ error: "Tabela 'follows' ná£o instalada no banco. Implementaçáo pendente." });

    await sql`DELETE FROM follows WHERE follower_user_id = ${userId} AND trainer_id = ${parseInt(trainerId, 10)}`;
    return res.status(200).json({ success: true, following: false });
  } catch (err) {
    console.error("Erro em DELETE /api/trainers/:id/follow", err);
    return res.status(500).json({ error: "Erro interno ao deixar de seguir trainer." });
  }
});

// Follow máºltiplos trainers de uma vez
app.post("/api/trainers/follow-multiple", verifyToken, async (req, res) => {
  const userId = req.userId;
  const { trainerIds } = req.body;

  try {
    // Validaçáo de entrada
    if (!Array.isArray(trainerIds) || trainerIds.length === 0) {
      return res.status(400).json({ error: "trainerIds deve ser um array ná£o vazio." });
    }

    if (trainerIds.length > 100) {
      return res.status(400).json({ error: "Má¡ximo de 100 trainers por vez." });
    }

    const [{ exists }] = await sql`SELECT to_regclass('public.follows') IS NOT NULL AS exists`;
    if (!exists) return res.status(501).json({ error: "Tabela 'follows' ná£o instalada no banco. Implementaçáo pendente." });

    // Filtra IDs vá¡lidos (náºmeros)
    const validIds = trainerIds.filter(id => !isNaN(parseInt(id, 10)));

    if (validIds.length === 0) {
      return res.status(400).json({ error: "Nenhum ID de trainer vá¡lido fornecido." });
    }

    // Insere máºltiplos follows (ignorando conflitos)
    for (const trainerId of validIds) {
      await sql`
        INSERT INTO follows (follower_user_id, trainer_id, created_at)
        VALUES (${userId}, ${trainerId}, CURRENT_TIMESTAMP)
        ON CONFLICT (follower_user_id, trainer_id) DO NOTHING
      `;
    }

    return res.status(200).json({
      success: true,
      message: `${validIds.length} trainer(s) adicionado(s) com sucesso.`,
      followedCount: validIds.length
    });
  } catch (err) {
    console.error("Erro em POST /api/trainers/follow-multiple", err);
    return res.status(500).json({ error: "Erro interno ao seguir máºltiplos trainers." });
  }
});

// --------------------- SOCIAL / SEGUIR USUÁRIOS --------------------- //

// Seguir um usuário
app.post("/api/user/:id/follow", verifyToken, async (req, res) => {
  const followerId = parseInt(req.userId);
  const followedId = await resolveUserId(req.params.id);

  if (!followedId) {
    return res.status(404).json({ error: "Usuário não encontrado." });
  }

  if (followerId === followedId) {
    return res.status(400).json({ error: "Você não pode seguir a si mesmo." });
  }

  try {
    await sql`
      INSERT INTO follows (follower_user_id, followed_user_id)
      VALUES (${followerId}, ${followedId})
      ON CONFLICT (follower_user_id, followed_user_id) DO NOTHING
    `;

    return res.status(200).json({ success: true, message: "Usuário seguido com sucesso." });
  } catch (err) {
    console.error("Erro ao seguir usuário:", err);
    return res.status(500).json({ error: "Erro interno ao seguir usuário." });
  }
});

// Deixar de seguir um usuário
app.delete("/api/user/:id/unfollow", verifyToken, async (req, res) => {
  const followerId = parseInt(req.userId);
  const followedId = await resolveUserId(req.params.id);

  if (!followedId) {
    return res.status(404).json({ error: "Usuário não encontrado." });
  }

  try {
    await sql`
      DELETE FROM follows 
      WHERE follower_user_id = ${followerId} AND followed_user_id = ${followedId}
    `;
    return res.status(200).json({ success: true, message: "Deixou de seguir com sucesso." });
  } catch (err) {
    console.error("Erro ao deixar de seguir:", err);
    return res.status(500).json({ error: "Erro interno ao deixar de seguir." });
  }
});

// Verificar se segue um usuário
app.get("/api/user/:id/follow-status", verifyToken, async (req, res) => {
  const followerId = parseInt(req.userId);
  const followedId = await resolveUserId(req.params.id);

  if (!followedId) {
    return res.status(200).json({ isFollowing: false });
  }

  try {
    const [follow] = await sql`
      SELECT 1 FROM follows 
      WHERE follower_user_id = ${followerId} AND followed_user_id = ${followedId}
      LIMIT 1
    `;
    return res.status(200).json({ isFollowing: !!follow });
  } catch (err) {
    console.error("Erro ao verificar follow status:", err);
    return res.status(200).json({ isFollowing: false });
  }
});

// -------------------- GRAFO / REDE DE SEGUIDORES -------------------- //

// Retorna um subgrafo (nodes + links) para um usuá¡rio, com profundidade configurá¡vel.
// Query params:
//  - userId (opcional): id do usuá¡rio raiz; se ausente, usa o usuá¡rio autenticado
//  - depth (opcional): profundidade de busca (padrá£o 2, má¡ximo 5)
//  - maxNodes (opcional): limite de ná³s retornados (padrá£o 500, má¡ximo 2000)
//  - direction (opcional): 'out' (seguindo), 'in' (seguidores) ou 'both' (padrá£o)
app.get("/api/graph/network", verifyToken, async (req, res) => {
  try {
    const startId = req.query.userId ? parseInt(req.query.userId, 10) : req.userId;
    if (!startId) return res.status(400).json({ error: "userId ná£o informado e sessá£o ná£o encontrada." });

    let depth = parseInt(req.query.depth || "2", 10);
    depth = Number.isNaN(depth) ? 2 : Math.min(Math.max(depth, 1), 5);

    let maxNodes = parseInt(req.query.maxNodes || "500", 10);
    maxNodes = Number.isNaN(maxNodes) ? 500 : Math.min(Math.max(maxNodes, 50), 2000);

    const direction = (req.query.direction || "both").toLowerCase();

    // Verifica se tabela 'follows' existe
    const [{ exists }] = await sql`SELECT to_regclass('public.follows') IS NOT NULL AS exists`;
    if (!exists) return res.status(501).json({ error: "Tabela 'follows' ná£o instalada. Execute as migrations para habilitar a rede de seguidores." });

    // Monta CTE recursivo dependendo da direçáo solicitada
    let idRows;
    if (direction === "out") {
      idRows = await sql`
        WITH RECURSIVE walk AS (
          SELECT ${startId} AS id, 0 AS depth
          UNION ALL
          SELECT f.trainer_id AS id, walk.depth + 1
          FROM follows f
          JOIN walk ON f.follower_user_id = walk.id
          WHERE walk.depth < ${depth}
        )
        SELECT DISTINCT id FROM walk LIMIT ${maxNodes};
      `;
    } else if (direction === "in") {
      idRows = await sql`
        WITH RECURSIVE walk AS (
          SELECT ${startId} AS id, 0 AS depth
          UNION ALL
          SELECT f.follower_user_id AS id, walk.depth + 1
          FROM follows f
          JOIN walk ON f.trainer_id = walk.id
          WHERE walk.depth < ${depth}
        )
        SELECT DISTINCT id FROM walk LIMIT ${maxNodes};
      `;
    } else {
      idRows = await sql`
        WITH RECURSIVE walk_out AS (
          SELECT ${startId} AS id, 0 AS depth
          UNION ALL
          SELECT f.trainer_id AS id, walk_out.depth + 1
          FROM follows f
          JOIN walk_out ON f.follower_user_id = walk_out.id
          WHERE walk_out.depth < ${depth}
        ), walk_in AS (
          SELECT ${startId} AS id, 0 AS depth
          UNION ALL
          SELECT f.follower_user_id AS id, walk_in.depth + 1
          FROM follows f
          JOIN walk_in ON f.trainer_id = walk_in.id
          WHERE walk_in.depth < ${depth}
        )
        SELECT DISTINCT id FROM (
          SELECT id FROM walk_out
          UNION
          SELECT id FROM walk_in
        ) t LIMIT ${maxNodes};
      `;
    }

    const ids = idRows.map((r) => r.id).filter(Boolean);

    // Se sá³ tiver o ná³ raiz, retornamos apenas ele
    if (ids.length === 0) {
      return res.status(200).json({ nodes: [], links: [] });
    }

    // Busca dados dos usuá¡rios (ná³s)
    const users = await sql`
      SELECT id_us AS id, nome AS name, username, avatar_url, role
      FROM usuarios
      WHERE id_us = ANY(${ids})
      LIMIT ${maxNodes}
    `;

    // Busca arestas (relacionamentos) entre os ná³s retornados
    const edges = await sql`
      SELECT follower_user_id AS source, trainer_id AS target, created_at
      FROM follows
      WHERE follower_user_id = ANY(${ids}) AND trainer_id = ANY(${ids})
    `;

    const nodes = users.map((u) => ({ id: u.id, name: u.name, username: u.username, avatar: u.avatar_url, role: u.role }));
    const links = edges.map((e) => ({ source: e.source, target: e.target, createdAt: e.created_at }));

    return res.status(200).json({ nodes, links, meta: { requestedFor: startId, depth, countNodes: nodes.length, countEdges: links.length } });
  } catch (err) {
    console.error("Erro em GET /api/graph/network:", err);
    return res.status(500).json({ error: "Erro interno ao gerar subgrafo.", details: err.message });
  }
});

// Search global simples
app.get("/api/search", verifyToken, async (req, res) => {
  const q = (req.query.q || "").trim();
  const limit = 5;
  if (!q) return res.status(400).json({ error: "Query 'q' é obrigatória." });

  try {
    const pattern = `%${q}%`;

    // 1. Buscar Trainers/Usuários (incluindo status de follow para evitar flicker)
    const trainers = await sql`
      SELECT u.id_us AS id, u.nome AS title, u.username AS subtitle, u.avatar_url AS image, u.role, u.banner_url,
             Coalesce(u.location, 'São Paulo') as location,
             Coalesce(u.job_title, 'Entusiasta Fitness') as job_title,
             EXISTS(SELECT 1 FROM follows f WHERE f.follower_user_id = ${req.userId} AND f.followed_user_id = u.id_us) as is_following
      FROM usuarios u
      WHERE u.nome ILIKE ${pattern} OR u.username ILIKE ${pattern}
      LIMIT ${limit}
    `;

    // 2. Buscar Academias
    const gyms = await sql`
      SELECT id_academia AS id, nome AS title, endereco_completo AS subtitle, 'gym' AS type
      FROM academias
      WHERE nome ILIKE ${pattern} OR endereco_completo ILIKE ${pattern}
      LIMIT ${limit}
    `;

    // 3. Buscar Dietas
    const diets = await sql`
      SELECT id_dieta AS id, nome AS title, descricao AS subtitle, imageurl AS image, 'diet' AS type
      FROM dietas
      WHERE nome ILIKE ${pattern} OR descricao ILIKE ${pattern}
      LIMIT ${limit}
    `;

    // 4. Buscar Comunidades
    const communities = await sql`
      SELECT id_comunidade AS id, nome AS title, descricao AS subtitle, imageurl AS image, 'community' AS type
      FROM comunidades
      WHERE nome ILIKE ${pattern} OR descricao ILIKE ${pattern}
      LIMIT ${limit}
    `;

    // Unificar resultados
    const results = [
      ...trainers.map((t) => {
        const isTrainer = t.role === 'trainer' || t.role === 'personal';
        return {
          id: t.id,
          title: t.title,
          subtitle: t.subtitle,
          image: t.image,
          type: isTrainer ? 'trainer' : 'user',
          target: isTrainer ? 'TrainerProfile' : 'ProfilePFScreen',
          data: {
            ...t,
            name: t.title,
            username: t.subtitle,
            photo: t.image,
            banner: t.banner_url,
            isFollowing: t.is_following
          }
        };
      }),
      ...gyms.map((g) => ({
        id: g.id,
        title: g.title,
        subtitle: g.subtitle,
        type: 'gym',
        target: 'MapScreen',
        data: g
      })),
      ...diets.map((d) => ({
        id: d.id,
        title: d.title,
        subtitle: d.subtitle,
        image: d.image,
        type: 'diet',
        target: 'DietDetails',
        data: d
      })),
      ...communities.map((c) => ({
        id: c.id,
        title: c.title,
        subtitle: c.subtitle,
        image: c.image,
        type: 'community',
        target: 'CommunityDetails',
        data: c
      }))
    ];

    return res.status(200).json({ data: results });
  } catch (err) {
    console.error("Erro em GET /api/search:", err);
    return res.status(500).json({ error: "Erro interno na busca." });
  }
});

// Obter perfil público de um usuário (incluindo is_following)
app.get("/api/user/:id", verifyToken, async (req, res) => {
  const userId = await resolveUserId(req.params.id);
  const requesterId = req.userId;

  if (!userId) {
    return res.status(404).json({ error: "Usuário não encontrado." });
  }

  try {
    const [user] = await sql`
      SELECT id_us as id, nome as name, username, avatar_url as photo, banner_url as banner,
             location, job_title, bio,
             EXISTS(SELECT 1 FROM follows f WHERE f.follower_user_id = ${requesterId} AND f.followed_user_id = id_us) as is_following
      FROM usuarios
      WHERE id_us = ${userId}
    `;

    if (!user) {
      return res.status(404).json({ error: "Usuário não encontrado." });
    }

    return res.status(200).json({
      success: true,
      data: {
        ...user,
        isFollowing: user.is_following
      }
    });
  } catch (err) {
    console.error("Erro em GET /api/user/:id:", err);
    return res.status(500).json({ error: "Erro interno ao buscar perfil." });
  }
});

// Atualizar bio do usuário
app.put("/api/user/bio", verifyToken, async (req, res) => {
  const userId = req.userId;
  const { bio } = req.body;

  // Validação: máximo 150 caracteres
  if (bio && bio.length > 150) {
    return res.status(400).json({
      error: "Bio deve ter no máximo 150 caracteres."
    });
  }

  try {
    await sql`
      UPDATE usuarios 
      SET bio = ${bio || null}, updated_at = NOW()
      WHERE id_us = ${userId}
    `;

    return res.status(200).json({
      success: true,
      message: "Bio atualizada com sucesso.",
      data: { bio }
    });
  } catch (err) {
    console.error("Erro ao atualizar bio:", err);
    return res.status(500).json({
      error: "Erro interno ao atualizar bio."
    });
  }
});

// Buscar posts de um usuário específico
app.get("/api/user/:id/posts", verifyToken, async (req, res) => {
  const userId = await resolveUserId(req.params.id);

  if (!userId) {
    return res.status(200).json({ success: true, data: [] });
  }

  try {
    const [{ exists }] = await sql`SELECT to_regclass('public.posts') IS NOT NULL AS exists`;

    if (!exists) {
      return res.status(200).json({ success: true, data: [] });
    }

    const posts = await sql`
      SELECT * FROM posts 
      WHERE id_us = ${userId} 
      ORDER BY created_at DESC
    `;

    return res.status(200).json({ success: true, data: posts });
  } catch (err) {
    console.error(`Erro em GET /api/user/${req.params.id}/posts`, err);
    return res.status(500).json({ error: "Erro ao buscar posts." });
  }
});

// Criar novo post
app.post("/api/user/posts", verifyToken, async (req, res) => {
  const userId = req.userId;
  // O frontend pode enviar 'url', 'imageurl'
  const { legenda, url, imageurl, tipo } = req.body;
  const finalUrl = url || imageurl;

  if (!finalUrl) {
    return res.status(400).json({ error: "URL da imagem é obrigatória." });
  }

  try {
    const [newPost] = await sql`
      INSERT INTO posts (id_us, image_url, legenda, tipo)
      VALUES (${userId}, ${finalUrl}, ${legenda || null}, ${tipo || 'POST'})
      RETURNING *
    `;

    return res.status(201).json({ success: true, message: "Post criado com sucesso!", data: newPost });
  } catch (err) {
    console.error("Erro em POST /api/user/posts", err);
    return res.status(500).json({ error: "Erro ao criar post." });
  }
});

// Obter estatísticas do usuário (posts, seguidores, seguindo)
app.get("/api/user/:id/stats", verifyToken, async (req, res) => {
  const userId = await resolveUserId(req.params.id);

  if (!userId) {
    return res.status(404).json({ error: "Usuário não encontrado." });
  }

  try {
    // Contar seguidores (quem segue este usuário)
    const [followersCount] = await sql`
      SELECT COUNT(*) as count
      FROM follows
      WHERE followed_user_id = ${userId}
    `;

    // Contar seguindo (quem este usuário segue)
    const [followingCount] = await sql`
      SELECT COUNT(*) as count
      FROM follows
      WHERE follower_user_id = ${userId}
    `;

    // Posts count real
    const [postsCountResult] = await sql`
      SELECT COUNT(*) as count 
      FROM posts 
      WHERE id_us = ${userId}
    `;
    const postsCount = parseInt(postsCountResult.count);

    return res.status(200).json({
      success: true,
      data: {
        posts: postsCount,
        followers: parseInt(followersCount.count),
        following: parseInt(followingCount.count)
      }
    });
  } catch (err) {
    console.error("Erro em GET /api/user/:id/stats:", err);
    return res.status(500).json({ error: "Erro interno ao buscar estatísticas." });
  }
});

// Obter lista de seguidores de um usuário
app.get("/api/user/:id/followers", verifyToken, async (req, res) => {
  const userId = req.params.id;
  const requesterId = req.userId;

  try {
    const followers = await sql`
      SELECT 
        u.id_us as id,
        u.nome as name,
        u.username,
        u.avatar_url as photo,
        EXISTS(
          SELECT 1 FROM follows f2 
          WHERE f2.follower_user_id = ${requesterId} 
          AND f2.followed_user_id = u.id_us
        ) as is_following
      FROM usuarios u
      INNER JOIN follows f ON f.follower_user_id = u.id_us
      WHERE f.followed_user_id = ${await resolveUserId(userId)}
      ORDER BY f.created_at DESC
    `;

    return res.status(200).json({
      success: true,
      data: followers.map(f => ({
        id: f.id,
        name: f.name,
        username: f.username,
        photo: f.photo,
        isFollowing: f.is_following
      }))
    });
  } catch (err) {
    console.error("Erro em GET /api/user/:id/followers:", err);
    return res.status(500).json({ error: "Erro interno ao buscar seguidores." });
  }
});

// Obter lista de quem o usuário está seguindo
app.get("/api/user/:id/following", verifyToken, async (req, res) => {
  const userId = req.params.id;
  const requesterId = req.userId;

  try {
    const following = await sql`
      SELECT 
        u.id_us as id,
        u.nome as name,
        u.username,
        u.avatar_url as photo,
        EXISTS(
          SELECT 1 FROM follows f2 
          WHERE f2.follower_user_id = ${requesterId} 
          AND f2.followed_user_id = u.id_us
        ) as is_following
      FROM usuarios u
      INNER JOIN follows f ON f.followed_user_id = u.id_us
      WHERE f.follower_user_id = ${await resolveUserId(userId)}
      ORDER BY f.created_at DESC
    `;

    return res.status(200).json({
      success: true,
      data: following.map(f => ({
        id: f.id,
        name: f.name,
        username: f.username,
        photo: f.photo,
        isFollowing: f.is_following
      }))
    });
  } catch (err) {
    console.error("Erro em GET /api/user/:id/following:", err);
    return res.status(500).json({ error: "Erro interno ao buscar seguindo." });
  }
});

// --------------------- COMENTÁRIOS E LIKES EM POSTS --------------------- //

// Obter comentários de um post
app.get("/api/user/posts/:id/comments", verifyToken, async (req, res) => {
  const postId = req.params.id;
  try {
    const comments = await sql`
      SELECT c.*, u.nome, u.username, u.avatar_url as photo
      FROM post_comments c
      JOIN usuarios u ON c.id_us = u.id_us
      WHERE c.post_id = ${parseInt(postId, 10)}
      ORDER BY c.created_at ASC
    `;
    return res.status(200).json({ success: true, data: comments });
  } catch (err) {
    console.error("Erro ao buscar comentários:", err);
    return res.status(500).json({ error: "Erro interno ao buscar comentários." });
  }
});

// Adicionar comentário em um post
app.post("/api/user/posts/:id/comment", verifyToken, async (req, res) => {
  const postId = req.params.id;
  const userId = req.userId;
  const { comentario } = req.body;

  if (!comentario) return res.status(400).json({ error: "Comentário é obrigatório." });

  try {
    const [newComment] = await sql`
      INSERT INTO post_comments (post_id, id_us, comentario)
      VALUES (${parseInt(postId, 10)}, ${userId}, ${comentario})
      RETURNING *
    `;

    // Incrementar contador de comentários
    await sql`UPDATE posts SET comments_count = comments_count + 1 WHERE id = ${parseInt(postId, 10)}`;

    return res.status(201).json({ success: true, data: newComment });
  } catch (err) {
    console.error("Erro ao adicionar comentário:", err);
    return res.status(500).json({ error: "Erro interno ao adicionar comentário." });
  }
});

// Curtir/Descurtir um post (Toggle)
app.post("/api/user/posts/:id/like", verifyToken, async (req, res) => {
  const postId = req.params.id;
  const userId = req.userId;

  try {
    const [existing] = await sql`
      SELECT id FROM post_likes WHERE post_id = ${parseInt(postId, 10)} AND id_us = ${userId}
    `;

    if (existing) {
      // Remover like
      await sql`DELETE FROM post_likes WHERE id = ${existing.id}`;
      await sql`UPDATE posts SET likes_count = GREATEST(0, likes_count - 1) WHERE id = ${parseInt(postId, 10)}`;
      return res.status(200).json({ success: true, isLiked: false });
    } else {
      // Adicionar like
      await sql`INSERT INTO post_likes (post_id, id_us) VALUES (${parseInt(postId, 10)}, ${userId})`;
      await sql`UPDATE posts SET likes_count = likes_count + 1 WHERE id = ${parseInt(postId, 10)}`;
      return res.status(200).json({ success: true, isLiked: true });
    }
  } catch (err) {
    console.error("Erro ao curtir post:", err);
    return res.status(500).json({ error: "Erro interno ao curtir post." });
  }
});

// Excluir um comentário
app.delete("/api/user/posts/comments/:id", verifyToken, async (req, res) => {
  const commentId = req.params.id;
  const userId = req.userId;

  try {
    const [comment] = await sql`SELECT post_id, id_us FROM post_comments WHERE id = ${parseInt(commentId, 10)}`;
    if (!comment) return res.status(404).json({ error: "Comentário não encontrado." });

    // Verificar se o usuário é dono do comentário
    if (comment.id_us !== userId) {
      return res.status(403).json({ error: "Não autorizado." });
    }

    await sql`DELETE FROM post_comments WHERE id = ${parseInt(commentId, 10)}`;
    await sql`UPDATE posts SET comments_count = GREATEST(0, comments_count - 1) WHERE id = ${comment.post_id}`;

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("Erro ao excluir comentário:", err);
    return res.status(500).json({ error: "Erro interno ao excluir comentário." });
  }
});

// Excluir um post
app.delete("/api/user/posts/:id", verifyToken, async (req, res) => {
  const postId = req.params.id;
  const userId = req.userId;

  try {
    const [post] = await sql`SELECT id_us FROM posts WHERE id = ${parseInt(postId, 10)}`;
    if (!post) return res.status(404).json({ error: "Post não encontrado." });

    if (post.id_us !== userId) {
      return res.status(403).json({ error: "Não autorizado." });
    }

    await sql`DELETE FROM posts WHERE id = ${parseInt(postId, 10)}`;
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("Erro ao excluir post:", err);
    return res.status(500).json({ error: "Erro interno ao excluir post." });
  }
});

// Notifications (consulta bá¡sica se tabela existir)
app.get("/api/notifications", verifyToken, async (req, res) => {
  const userId = req.userId;
  try {
    const [{ exists }] = await sql`SELECT to_regclass('public.notifications') IS NOT NULL AS exists`;
    if (!exists) return res.status(200).json({ data: [] });

    const data = await sql`
      SELECT id, title, message, type, read, timestamp
      FROM notifications
      WHERE user_id = ${userId}
      ORDER BY timestamp DESC
      LIMIT 100
    `;
    return res.status(200).json({ data });
  } catch (err) {
    console.error("Erro em GET /api/notifications", err);
    return res.status(500).json({ error: "Erro interno ao buscar notificaá§áµes." });
  }
});

app.put("/api/notifications/:id/read", verifyToken, async (req, res) => {
  const userId = req.userId;
  const id = req.params.id;
  try {
    const [{ exists }] = await sql`SELECT to_regclass('public.notifications') IS NOT NULL AS exists`;
    if (!exists) return res.status(501).json({ error: "Tabela 'notifications' ná£o instalada." });
    await sql`UPDATE notifications SET read = true WHERE id = ${id} AND user_id = ${userId}`;
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("Erro em PUT /api/notifications/:id/read", err);
    return res.status(500).json({ error: "Erro interno ao marcar notificacao." });
  }
});

// Endpoint para gerar signed upload (placeholder quando ná£o houver S3 direto)
app.post("/api/uploads/sign", verifyToken, async (req, res) => {
  // Este endpoint pode ser implementado para S3/GCS, aqui oferecemos comportamento má­nimo
  const { filename, contentType, purpose } = req.body || {};
  if (!filename || !contentType) return res.status(400).json({ error: "Informe filename e contentType." });
  if (!supabase) return res.status(501).json({ error: "Signed uploads ná£o configurados neste ambiente. Use multipart ou configure storage." });
  // Como fallback retornamos um suggested public path e instruá§áµes
  const suggestedKey = `${purpose || 'uploads'}/${uuidv4()}_${filename}`;
  return res.status(200).json({ uploadUrl: null, publicUrl: `supabase://${AVATAR_BUCKET}/${suggestedKey}`, message: "Presigned upload ná£o implementado no servidor; faá§a upload via backend ou configure S3." });
});

// -------------------------------- DIETAS ---------------------------- //

app.post("/api/dietas", verifyToken, async (req, res) => {
  console.log("=== INáCIO DA ROTA POST /api/dietas ===");
  console.log("Timestamp:", new Date().toISOString());
  console.log("User ID:", req.userId);

  // Log detalhado dos dados recebidos do frontend
  console.log("--- DADOS RECEBIDOS DO FRONTEND ---");
  console.log("Headers:", JSON.stringify(req.headers, null, 2));
  console.log("Body completo:", JSON.stringify(req.body, null, 2));

  const userId = req.userId;
  const {
    nome,
    imageurl,
    categoria,
    calorias,
    tempo_preparo,
    gordura,
    proteina,
    carboidratos,
  } = req.body;
  const descricao = req.body.descricao ?? req.body.descripcion ?? null;

  // Log dos dados extraá­dos
  console.log("--- DADOS EXTRAáDOS ---");
  console.log("Nome:", nome);
  console.log("Descriçáo:", descricao);
  console.log("Image URL:", imageurl);
  console.log("Categoria:", categoria);
  console.log("Calorias:", calorias);
  console.log("Tempo de preparo:", tempo_preparo);
  console.log("Gordura:", gordura);
  console.log("Proteá­na:", proteina);
  console.log("Carboidratos:", carboidratos);

  // Validaçáo com logs detalhados
  console.log("--- VALIDAá‡áƒO DOS DADOS ---");
  const validationErrors = [];

  if (!nome) {
    validationErrors.push("Nome á© obrigatá³rio");
    console.log("âŒ ERRO: Nome ná£o fornecido");
  } else {
    console.log("âœ… Nome vá¡lido:", nome);
  }

  if (!descricao) {
    validationErrors.push("Descriçáo á© obrigatá³ria");
    console.log("âŒ ERRO: Descriçáo ná£o fornecida");
  } else {
    console.log("âœ… Descriçáo vá¡lida:", descricao.substring(0, 50) + "...");
  }

  if (!imageurl) {
    validationErrors.push("URL da imagem á© obrigatá³ria");
    console.log("âŒ ERRO: URL da imagem ná£o fornecida");
  } else {
    console.log("âœ… URL da imagem vá¡lida:", imageurl);
  }

  if (!categoria) {
    validationErrors.push("Categoria á© obrigatá³ria");
    console.log("âŒ ERRO: Categoria ná£o fornecida");
  } else {
    console.log("âœ… Categoria vá¡lida:", categoria);
  }

  if (validationErrors.length > 0) {
    console.log("--- FALHA NA VALIDAá‡áƒO ---");
    console.log("Erros encontrados:", validationErrors);
    console.log("=== FIM DA ROTA POST /api/dietas (ERRO 400) ===");
    return res.status(400).json({
      error: "Dados obrigatá³rios ná£o fornecidos.",
      details: validationErrors,
    });
  }

  console.log("âœ… Todas as validaá§áµes passaram");

  try {
    console.log("--- BUSCANDO DADOS DO AUTOR ---");
    console.log("Buscando usuá¡rio com ID:", userId);

    const [author] =
      await sql`SELECT nome, username, email FROM usuarios WHERE id_us = ${userId}`;

    if (!author) {
      console.log("âŒ ERRO: Usuá¡rio autor ná£o encontrado no banco de dados");
      console.log("=== FIM DA ROTA POST /api/dietas (ERRO 404) ===");
      return res.status(404).json({ error: "Usuá¡rio autor ná£o encontrado." });
    }

    console.log("âœ… Autor encontrado:", {
      nome: author.nome,
      username: author.username,
      email: author.email,
    });

    const authorName = author.nome || author.username || null;
    const authorAvatarUrl = getGravatarUrl(author.email);

    console.log("--- PREPARANDO DADOS PARA INSERá‡áƒO ---");
    console.log("Nome do autor:", authorName);
    console.log("Avatar URL do autor:", authorAvatarUrl);

    console.log("--- EXECUTANDO INSERT NO BANCO DE DADOS ---");
    const [newDieta] = await sql`
      INSERT INTO dietas (
        id_us, nome, descricao, imageurl, calorias, tempo_preparo,
        gordura, proteina, carboidratos, nome_autor, avatar_autor_url,
        createdat, updatedat, categoria
      )
      VALUES (
        ${userId}, ${nome}, ${descricao}, ${imageurl}, ${calorias || null},
        ${tempo_preparo || null}, ${gordura || null}, ${proteina || null},
        ${carboidratos || null}, ${authorName || null}, ${authorAvatarUrl || null},
        ${new Date()}, ${new Date()}, ${categoria}
      )
      RETURNING *;
    `;

    console.log("âœ… Dieta inserida com sucesso no banco de dados");
    console.log("--- DADOS DA DIETA CRIADA ---");
    console.log("ID da dieta:", newDieta.id_dieta);
    console.log("Nome:", newDieta.nome);
    console.log("Categoria:", newDieta.categoria);
    console.log("Data de criaçáo:", newDieta.createdat);

    console.log("--- RESPOSTA DE SUCESSO ---");
    console.log("Status: 201 - Created");
    console.log("=== FIM DA ROTA POST /api/dietas (SUCESSO) ===");

    res.status(201).json({
      message: "Dieta criada com sucesso!",
      data: newDieta,
    });
  } catch (error) {
    console.log("--- ERRO DURANTE A EXECUá‡áƒO ---");
    console.error("âŒ ERRO ao criar dieta:", error);
    console.log("Tipo do erro:", error.constructor.name);
    console.log("Cá³digo do erro:", error.code);
    console.log("Mensagem do erro:", error.message);
    console.log("Stack trace:", error.stack);

    console.log("--- RESPOSTA DE ERRO ---");
    console.log("Status: 500 - Internal Server Error");
    console.log("=== FIM DA ROTA POST /api/dietas (ERRO 500) ===");

    res.status(500).json({
      error: "Erro interno do servidor ao criar dieta.",
      details: error.message,
    });
  }
});

app.get("/api/dietas", verifyToken, async (req, res) => {

  const userId = req.userId;
  const { categoria } = req.query;

  try {
    let query = sql`SELECT id_us, nome, descricao, imageurl, calorias, tempo_preparo, gordura, proteina, carboidratos, nome_autor, avatar_autor_url, createdat, updatedat, categoria, id_dieta FROM dietas WHERE id_us = ${userId}`;

    if (categoria) {
      query = sql`${query} AND categoria = ${categoria}`;
    }

    query = sql`${query} ORDER BY createdat DESC;`;

    const dietas = await query;
    res.status(200).json({ data: dietas });
  } catch (error) {
    console.error("Erro ao listar dietas:", error);
    res.status(500).json({
      error: "Erro interno do servidor ao listar dietas.",
      details: error.message,
    });
  }
});

app.put("/api/dietas/:id_dieta", verifyToken, async (req, res) => {

  const userId = req.userId;
  const { id_dieta } = req.params;
  const {
    nome,
    descricao,
    imageurl,
    categoria,
    calorias,
    tempo_preparo,
    gordura,
    proteina,
    carboidratos,
    nome_autor,
    avatar_autor_url,
  } = req.body;

  if (!nome || !descricao || !imageurl || !categoria) {
    return res
      .status(400)
      .json({ error: "Nome, descriçáo, imagem e categoria sá£o obrigatá³rios." });
  }

  try {
    const [updatedDieta] = await sql`
      UPDATE dietas
      SET
        nome = ${nome},
        descricao = ${descricao},
        imageurl = ${imageurl},
        calorias = COALESCE(${calorias || null}, calorias),
        tempo_preparo = COALESCE(${tempo_preparo || null}, tempo_preparo),
        gordura = COALESCE(${gordura || null}, gordura),
        proteina = COALESCE(${proteina || null}, proteina),
        carboidratos = COALESCE(${carboidratos || null}, carboidratos),
        nome_autor = COALESCE(${nome_autor || null}, nome_autor),
        avatar_autor_url = COALESCE(${avatar_autor_url || null}, avatar_autor_url),
        categoria = ${categoria},
        updatedat = ${new Date()}
      WHERE id_dieta = ${id_dieta} AND id_us = ${userId}
      RETURNING *;
    `;

    if (!updatedDieta) {
      return res.status(404).json({
        error: "Dieta ná£o encontrada ou vocáª ná£o tem permissá£o para editá¡-la.",
      });
    }
    res
      .status(200)
      .json({ message: "Dieta atualizada com sucesso!", data: updatedDieta });
  } catch (error) {
    console.error("Erro ao editar dieta:", error);
    res.status(500).json({
      error: "Erro interno do servidor ao editar dieta.",
      details: error.message,
    });
  }
});

app.delete("/api/dietas/:id_dieta", verifyToken, async (req, res) => {

  const userId = req.userId;
  const { id_dieta } = req.params;

  try {
    const [deletedDieta] = await sql`
      DELETE FROM dietas
      WHERE id_dieta = ${id_dieta} AND id_us = ${userId}
      RETURNING *;
    `;

    if (!deletedDieta) {
      return res.status(404).json({
        error: "Dieta ná£o encontrada ou vocáª ná£o tem permissá£o para excluá­-la.",
      });
    }
    res.status(200).json({ message: "Dieta excluá­da com sucesso!" });
  } catch (error) {
    console.error("Erro ao excluir dieta:", error);
    res.status(500).json({
      error: "Erro interno do servidor ao excluir dieta.",
      details: error.message,
    });
  }
});

// -------------------------------- CHAT ---------------------------- //

app.post("/api/chat", verifyToken, async (req, res) => {
  console.log("=== INáCIO DA ROTA POST /api/chat ===");
  console.log("Timestamp:", new Date().toISOString());
  console.log("User ID:", req.userId);

  // Log detalhado dos dados recebidos do frontend
  console.log("--- DADOS RECEBIDOS DO FRONTEND ---");
  console.log("Headers:", JSON.stringify(req.headers, null, 2));
  console.log("Body completo:", JSON.stringify(req.body, null, 2));

  const userId = req.userId; // ID do seu banco de dados (inteiro)
  const { participant2_id } = req.body;

  // Log dos dados extraá­dos
  console.log("--- DADOS EXTRAáDOS ---");
  console.log("Participant2 ID:", participant2_id);

  // Validaçáo com logs detalhados
  console.log("--- VALIDAá‡áƒO DOS DADOS ---");
  const validationErrors = [];

  if (!participant2_id) {
    validationErrors.push("Participant2 ID á© obrigatá³rio");
    console.log("âŒ ERRO: Participant2 ID ná£o fornecido");
  } else {
    console.log("âœ… Participant2 ID vá¡lido:", participant2_id);
  }

  if (validationErrors.length > 0) {
    console.log("--- FALHA NA VALIDAá‡áƒO ---");
    console.log("Erros encontrados:", validationErrors);
    console.log("=== FIM DA ROTA POST /api/chat (ERRO 400) ===");
    return res.status(400).json({
      error: "Dados obrigatá³rios ná£o fornecidos.",
      details: validationErrors,
    });
  }

  console.log("âœ… Todas as validaá§áµes passaram");

  try {
    // Testar conexá£o com o banco de dados antes de tentar a consulta
    try {
      await sql`SELECT 1`;
    } catch (dbError) {
      console.error("Erro na conexá£o com o banco de dados:", dbError);
      return res.status(503).json({
        error: "Serviá§o de banco de dados temporariamente indisponá­vel.",
        details: dbError.message
      });
    }

    console.log("--- VERIFICANDO SE USUáRIOS EXISTEM ---");
    console.log("Buscando usuá¡rio com ID:", participant2_id);

    // Verificar se o outro usuá¡rio existe no seu banco de dados
    const [otherUser] = await sql`
      SELECT id_us FROM usuarios WHERE id_us = ${participant2_id}
    `;

    if (!otherUser) {
      console.log("âŒ ERRO: Usuá¡rio participante ná£o encontrado no banco de dados");
      console.log("=== FIM DA ROTA POST /api/chat (ERRO 404) ===");
      return res.status(404).json({ error: "Usuá¡rio participante ná£o encontrado." });
    }

    console.log("âœ… Usuá¡rio participante encontrado:", otherUser.id_us);

    // Obter os UUIDs do Supabase Auth para ambos os usuá¡rios
    const currentUserMapping = await getUserAuthId(userId);
    const otherUserMapping = await getUserAuthId(participant2_id);

    if (!currentUserMapping || !otherUserMapping) {
      console.log("âŒ ERRO: Usuá¡rios ná£o encontrados no sistema de autenticaçáo do Supabase");
      return res.status(404).json({
        error: "Usuá¡rios ná£o encontrados no sistema de autenticaçáo."
      });
    }

    const currentUserId = currentUserMapping.auth_user_id;
    const otherUserId = otherUserMapping.auth_user_id;

    console.log("âœ… UUIDs do Supabase Auth obtidos");
    console.log("Current user UUID:", currentUserId);
    console.log("Other user UUID:", otherUserId);

    // Verificar se já¡ existe um chat entre esses dois usuá¡rios no Supabase
    console.log("--- VERIFICANDO SE CHAT Já EXISTE NO SUPABASE ---");
    const { data: existingChat, error: chatError } = await supabase
      .from('chats')
      .select('id')
      .or(`and(participant1_id.eq.${currentUserId},participant2_id.eq.${otherUserId}),and(participant1_id.eq.${otherUserId},participant2_id.eq.${currentUserId})`)
      .single();

    if (existingChat && !chatError) {
      console.log("âœ… Chat já¡ existe com ID:", existingChat.id);
      return res.status(200).json({
        message: "Chat já¡ existente",
        chatId: existingChat.id,
        data: existingChat,
      });
    }

    console.log("--- CRIANDO NOVO CHAT NO SUPABASE ---");

    // Criar o novo chat no Supabase
    const { data: newChat, error: insertError } = await supabase
      .from('chats')
      .insert({
        participant1_id: currentUserId,
        participant2_id: otherUserId,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (insertError) {
      console.error("Erro ao criar chat no Supabase:", insertError);
      return res.status(500).json({
        error: "Erro ao criar chat.",
        details: insertError.message
      });
    }

    console.log("âœ… Chat inserido com sucesso no Supabase");
    console.log("--- DADOS DO CHAT CRIADO ---");
    console.log("ID do chat:", newChat.id);
    console.log("Participant1 ID:", newChat.participant1_id);
    console.log("Participant2 ID:", newChat.participant2_id);
    console.log("Data de criaçáo:", newChat.created_at);

    console.log("--- RESPOSTA DE SUCESSO ---");
    console.log("Status: 201 - Created");
    console.log("=== FIM DA ROTA POST /api/chat (SUCESSO) ===");

    res.status(201).json({
      message: "Chat criado com sucesso!",
      chatId: newChat.id,
      data: newChat,
    });
  } catch (error) {
    console.log("--- ERRO DURANTE A EXECUá‡áƒO ---");
    console.error("âŒ ERRO ao criar chat:", error);
    console.log("Tipo do erro:", error.constructor.name);
    console.log("Cá³digo do erro:", error.code);
    console.log("Mensagem do erro:", error.message);
    console.log("Stack trace:", error.stack);

    // Verificar se á© um erro de conexá£o com o banco de dados
    if (error.message && (error.message.includes('Tenant or user not found') || error.message.includes('FATAL'))) {
      return res.status(503).json({
        error: "Erro de conexá£o com o banco de dados. Serviá§o temporariamente indisponá­vel.",
        details: "O sistema de chat está¡ temporariamente indisponá­vel. Tente novamente mais tarde."
      });
    }

    console.log("--- RESPOSTA DE ERRO ---");
    console.log("Status: 500 - Internal Server Error");
    console.log("=== FIM DA ROTA POST /api/chat (ERRO 500) ===");

    res.status(500).json({
      error: "Erro interno do servidor ao criar chat.",
      details: error.message,
    });
  }
});

app.get("/api/chat/contacts/mutual", verifyToken, async (req, res) => {
  const userId = req.userId;
  try {
    // Busca usuários que seguem o atual AND são seguidos pelo atual
    const mutualFollowers = await sql`
      SELECT 
        u.id_us AS id, 
        u.nome AS name, 
        u.username, 
        u.avatar_url AS avatar
      FROM usuarios u
      WHERE u.id_us IN (
        SELECT f1.followed_user_id 
        FROM follows f1
        WHERE f1.follower_user_id = ${userId}
        INTERSECT
        SELECT f2.follower_user_id 
        FROM follows f2
        WHERE f2.followed_user_id = ${userId}
      )
    `;

    return res.status(200).json({ data: mutualFollowers });
  } catch (err) {
    console.error("Erro ao buscar seguidores mútuos:", err);
    return res.status(500).json({ error: "Erro interno ao buscar contatos." });
  }
});

// Rota solicitada pelo app: contatos que o usuário segue
app.get("/api/chat/contacts/following", verifyToken, async (req, res) => {
  const userId = req.userId;
  try {
    const following = await sql`
      SELECT 
        u.id_us AS id, 
        u.nome AS name, 
        u.username, 
        u.avatar_url AS avatar
      FROM usuarios u
      JOIN follows f ON u.id_us = f.followed_user_id
      WHERE f.follower_user_id = ${userId}
    `;
    return res.status(200).json({ data: following });
  } catch (err) {
    console.error("Erro ao buscar contatos seguidos:", err);
    return res.status(500).json({ error: "Erro interno ao buscar contatos." });
  }
});

app.get("/api/chat", verifyToken, async (req, res) => {

  const userId = req.userId; // ID do seu banco de dados (inteiro)

  try {
    // Testar conexá£o com o banco de dados antes de tentar a consulta
    try {
      await sql`SELECT 1`;
    } catch (dbError) {
      console.error("Erro na conexá£o com o banco de dados:", dbError);
      return res.status(503).json({
        error: "Serviá§o de banco de dados temporariamente indisponá­vel.",
        details: dbError.message
      });
    }

    // Obter o UUID do Supabase Auth para o usuá¡rio atual
    const userMapping = await getUserAuthId(userId);
    if (!userMapping) {
      return res.status(404).json({
        error: "Usuá¡rio ná£o encontrado no sistema de autenticaçáo."
      });
    }

    const supabaseUserId = userMapping.auth_user_id;

    // Buscar todos os chats em que o usuá¡rio participa no Supabase
    const { data: chats, error: chatError } = await supabase
      .from('chats')
      .select(`
        id,
        participant1_id,
        participant2_id,
        last_message,
        last_timestamp,
        unread_count_p1,
        unread_count_p2,
        last_sender_id,
        created_at
      `)
      .or(`participant1_id.eq.${supabaseUserId},participant2_id.eq.${supabaseUserId}`)
      .order('last_timestamp', { ascending: false });

    if (chatError) {
      console.error("Erro ao buscar chats no Supabase:", chatError);
      return res.status(500).json({
        error: "Erro ao obter chats.",
        details: chatError.message
      });
    }

    // Mapear os resultados para incluir unread_count apropriado e dados do participante
    const chatsWithDetails = await Promise.all(chats.map(async (chat) => {
      const otherParticipantId = chat.participant1_id === supabaseUserId
        ? chat.participant2_id
        : chat.participant1_id;

      let participantName = `User ${otherParticipantId.substring(0, 5)}`;
      let participantAvatar = "https://i.pravatar.cc/150?img=1";

      try {
        // Obter dados diretamente da tabela usuarios pelo auth_user_id
        const [user] = await sql`
          SELECT nome, avatar_url FROM usuarios WHERE auth_user_id = ${otherParticipantId}
        `;
        if (user) {
          participantName = user.nome;
          participantAvatar = user.avatar_url || participantAvatar;
        }
      } catch (err) {
        console.error("Erro ao buscar detalhes do participante:", otherParticipantId, err);
      }

      return {
        ...chat,
        unread_count: chat.participant1_id === supabaseUserId
          ? chat.unread_count_p2
          : chat.unread_count_p1,
        participant_name: participantName,
        participant_avatar: participantAvatar
      };
    }));

    res.status(200).json({ data: chatsWithDetails });
  } catch (error) {
    console.error("Erro ao listar chats:", error);

    // Verificar se á© um erro de conexá£o com o banco de dados
    if (error.message && (error.message.includes('Tenant or user not found') || error.message.includes('FATAL'))) {
      return res.status(503).json({
        error: "Erro de conexá£o com o banco de dados. Serviá§o temporariamente indisponá­vel.",
        details: "O sistema está¡ temporariamente indisponá­vel. Tente novamente mais tarde."
      });
    }

    res.status(500).json({
      error: "Erro interno do servidor ao obter chats.",
      details: error.message,
    });
  }
});

// Rota para deletar ou atualizar chat removida para simplificaçáo ou movida
app.put("/api/chat/:id_chat", verifyToken, async (req, res) => {

  const userId = req.userId;
  const { id_chat } = req.params;
  const { last_message, last_timestamp } = req.body;

  try {
    // Verificar se o usuá¡rio á© parte do chat
    const [chat] = await sql`
      SELECT participant1_id, participant2_id
      FROM chats
      WHERE id = ${id_chat}
    `;

    if (!chat || (chat.participant1_id !== userId && chat.participant2_id !== userId)) {
      return res.status(403).json({
        error: "Vocáª ná£o tem permissá£o para atualizar este chat.",
      });
    }

    // Atualizar o chat
    const [updatedChat] = await sql`
      UPDATE chats
      SET
        last_message = COALESCE(${last_message || null}, last_message),
        last_timestamp = COALESCE(${last_timestamp || new Date()}, last_timestamp)
      WHERE id = ${id_chat}
      RETURNING *;
    `;

    if (!updatedChat) {
      return res.status(404).json({
        error: "Chat ná£o encontrado ou vocáª ná£o tem permissá£o para editá¡-lo.",
      });
    }

    res
      .status(200)
      .json({ message: "Chat atualizado com sucesso!", data: updatedChat });
  } catch (error) {
    console.error("Erro ao editar chat:", error);
    res.status(500).json({
      error: "Erro interno do servidor ao editar chat.",
      details: error.message,
    });
  }
});

app.delete("/api/chat/:id_chat", verifyToken, async (req, res) => {

  const userId = req.userId;
  const { id_chat } = req.params;

  try {
    // Verificar se o usuá¡rio á© parte do chat
    const [chat] = await sql`
      SELECT participant1_id, participant2_id
      FROM chats
      WHERE id = ${id_chat}
    `;

    if (!chat || (chat.participant1_id !== userId && chat.participant2_id !== userId)) {
      return res.status(403).json({
        error: "Vocáª ná£o tem permissá£o para excluir este chat.",
      });
    }

    const [deletedChat] = await sql`
      DELETE FROM chats
      WHERE id = ${id_chat} AND (participant1_id = ${userId} OR participant2_id = ${userId})
      RETURNING *;
    `;

    if (!deletedChat) {
      return res.status(404).json({
        error: "Chat ná£o encontrado ou vocáª ná£o tem permissá£o para excluá­-lo.",
      });
    }
    res.status(200).json({ message: "Chat excluá­do com sucesso!" });
  } catch (error) {
    console.error("Erro ao excluir chat:", error);
    res.status(500).json({
      error: "Erro interno do servidor ao excluir chat.",
      details: error.message,
    });
  }
});

// Rota para enviar mensagem
app.post("/api/chat/:id_chat/messages", verifyToken, async (req, res) => {

  const userId = req.userId; // ID do banco (inteiro)
  const { id_chat } = req.params;
  const { text, image_url } = req.body;

  if (!text && !image_url) {
    return res.status(400).json({ error: "Texto ou imagem á© obrigatá³rio." });
  }

  try {
    // Obter UUID do Supabase diretamente da tabela usuarios
    const [user] = await sql`SELECT auth_user_id FROM usuarios WHERE id_us = ${userId}`;
    if (!user || !user.auth_user_id) {
      return res.status(404).json({ error: "ID de autenticaçáo ná£o encontrado para este usuá¡rio." });
    }
    const supabaseUserId = user.auth_user_id;

    // Verificar se o usuá¡rio faz parte do chat
    const { data: chat, error: chatErr } = await supabase
      .from('chats')
      .select('id, participant1_id, participant2_id')
      .eq('id', id_chat)
      .single();

    if (chatErr || !chat) {
      return res.status(404).json({ error: "Chat ná£o encontrado." });
    }

    if (chat.participant1_id !== supabaseUserId && chat.participant2_id !== supabaseUserId) {
      return res.status(403).json({ error: "Sem permissá£o para este chat." });
    }

    const encryptedText = text ? encryptMessage(text) : null;

    const { data: newMessage, error: msgErr } = await supabase
      .from('messages')
      .insert({
        chat_id: id_chat,
        sender_id: supabaseUserId,
        text: encryptedText,
        image_url: image_url || null,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (msgErr) throw msgErr;

    // Atualizar meta do chat e incrementar contador de não lidas para o destinatário
    if (chat.participant1_id === supabaseUserId) {
      // P1 enviou -> incrementa unread_count_p1 (que é o que P2 vê)
      await sql`
        UPDATE chats 
        SET 
          unread_count_p1 = unread_count_p1 + 1,
          last_message = ${text || 'Imagem'},
          last_timestamp = NOW(),
          last_sender_id = ${supabaseUserId}
        WHERE id = ${id_chat}
      `;
    } else {
      // P2 enviou -> incrementa unread_count_p2 (que é o que P1 vê)
      await sql`
        UPDATE chats 
        SET 
          unread_count_p2 = unread_count_p2 + 1,
          last_message = ${text || 'Imagem'},
          last_timestamp = NOW(),
          last_sender_id = ${supabaseUserId}
        WHERE id = ${id_chat}
      `;
    }

    res.status(201).json({ data: newMessage });
  } catch (error) {
    console.error("Erro no POST messages:", error);
    res.status(500).json({ error: "Erro interno", details: error.message });
  }
});

// Rota para obter mensagens de um chat
app.get("/api/chat/:id_chat/messages", verifyToken, async (req, res) => {

  const userId = req.userId;
  const { id_chat } = req.params;
  const { limit = 50, offset = 0 } = req.query;

  try {
    const [user] = await sql`SELECT auth_user_id FROM usuarios WHERE id_us = ${userId}`;
    if (!user || !user.auth_user_id) {
      return res.status(404).json({ error: "ID de autenticaçáo ná£o encontrado." });
    }
    const supabaseUserId = user.auth_user_id;

    const { data: chat, error: chatErr } = await supabase
      .from('chats')
      .select('id, participant1_id, participant2_id')
      .eq('id', id_chat)
      .single();

    if (chatErr || !chat) {
      return res.status(404).json({ error: "Chat ná£o encontrado." });
    }

    if (chat.participant1_id !== supabaseUserId && chat.participant2_id !== supabaseUserId) {
      return res.status(403).json({ error: "Acesso negado." });
    }

    const { data: rawMessages, error: msgErr } = await supabase
      .from('messages')
      .select('*')
      .eq('chat_id', id_chat)
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (msgErr) throw msgErr;

    const messages = rawMessages.map(m => ({
      ...m,
      text: m.text ? decryptMessage(m.text) : m.text
    }));

    res.status(200).json({ data: messages });
  } catch (error) {
    console.error("Erro no GET messages:", error);
    res.status(500).json({ error: "Erro interno", details: error.message });
  }
});

// Novo: Rota para marcar mensagens como lidas
app.post("/api/chat/:id_chat/read", verifyToken, async (req, res) => {
  const userId = req.userId;
  const { id_chat } = req.params;

  try {
    // 1. Obter UUID do Supabase
    const [user] = await sql`SELECT auth_user_id FROM usuarios WHERE id_us = ${userId}`;
    if (!user || !user.auth_user_id) {
      return res.status(404).json({ error: "ID de autenticação não encontrado." });
    }
    const supabaseUserId = user.auth_user_id;

    // 2. Verificar se o chat existe
    const { data: chat, error: chatErr } = await supabase
      .from('chats')
      .select('id, participant1_id, participant2_id')
      .eq('id', id_chat)
      .single();

    if (chatErr || !chat) {
      return res.status(404).json({ error: "Chat não encontrado." });
    }

    if (chat.participant1_id !== supabaseUserId && chat.participant2_id !== supabaseUserId) {
      return res.status(403).json({ error: "Acesso negado." });
    }

    // 3. Zerar o contador de não lidas para este usuário
    // Se eu sou p1, meu contador é unread_count_p2 (mensagens vindas de p2)
    // Se eu sou p2, meu contador é unread_count_p1 (mensagens vindas de p1)
    if (chat.participant1_id === supabaseUserId) {
      await sql`UPDATE chats SET unread_count_p2 = 0 WHERE id = ${id_chat}`;
    } else {
      await sql`UPDATE chats SET unread_count_p1 = 0 WHERE id = ${id_chat}`;
    }

    // 4. Marcar todas as mensagens recebidas como lidas
    await supabase
      .from('messages')
      .update({ is_read: true })
      .eq('chat_id', id_chat)
      .neq('sender_id', supabaseUserId);

    res.status(200).json({ message: "Mensagens marcadas como lidas." });
  } catch (error) {
    console.error("Erro no POST /chat/:id/read:", error);
    res.status(500).json({ error: "Erro interno", details: error.message });
  }
});

// Novo: Rota para deletar uma mensagem individual
app.delete("/api/chat/messages/:id_message", verifyToken, async (req, res) => {
  const userId = req.userId;
  const { id_message } = req.params;

  try {
    // 1. Obter UUID do Supabase
    const [user] = await sql`SELECT auth_user_id FROM usuarios WHERE id_us = ${userId}`;
    if (!user || !user.auth_user_id) {
      return res.status(404).json({ error: "ID de autenticação não encontrado." });
    }
    const supabaseUserId = user.auth_user_id;

    // 2. Buscar a mensagem para verificar o remetente e obter o chat_id
    const { data: message, error: fetchErr } = await supabase
      .from('messages')
      .select('sender_id, chat_id')
      .eq('id', id_message)
      .single();

    if (fetchErr || !message) {
      return res.status(404).json({ error: "Mensagem não encontrada." });
    }

    const chatId = message.chat_id;

    // 3. Verificar se o usuário é o remetente da mensagem
    if (message.sender_id !== supabaseUserId) {
      return res.status(403).json({ error: "Você só pode deletar suas próprias mensagens." });
    }

    // 4. Deletar a mensagem
    const { error: deleteErr } = await supabase
      .from('messages')
      .delete()
      .eq('id', id_message);

    if (deleteErr) throw deleteErr;

    // 5. Verificar se ainda restam mensagens no chat
    const { data: remainingMessages, error: countErr } = await supabase
      .from('messages')
      .select('id, text, created_at, sender_id')
      .eq('chat_id', chatId)
      .order('created_at', { ascending: false });

    if (countErr) {
      console.error("Erro ao contar mensagens restantes:", countErr);
    } else if (remainingMessages.length === 0) {
      // 6. Se não restam mensagens, deletar o chat do Supabase e do banco local
      console.log(`[Chat Cleanup] Deletando chat vazio: ${chatId}`);

      // Deleta do Supabase
      await supabase.from('chats').delete().eq('id', chatId);

      // Deleta do Postgres local
      await sql`DELETE FROM chats WHERE id = ${chatId}`;
    } else {
      // 7. Se ainda existem mensagens, atualizar o preview do chat com a mensagem mais recente
      const lastMsg = remainingMessages[0];
      const decryptedText = lastMsg.text ? decryptMessage(lastMsg.text) : 'Imagem';

      await sql`
        UPDATE chats 
        SET 
          last_message = ${decryptedText},
          last_timestamp = ${lastMsg.created_at},
          last_sender_id = ${lastMsg.sender_id}
        WHERE id = ${chatId}
      `;
    }

    res.status(200).json({ message: "Mensagem deletada com sucesso e chat sincronizado!" });
  } catch (error) {
    console.error("Erro ao deletar mensagem:", error);
    res.status(500).json({ error: "Erro interno", details: error.message });
  }
});

// -------------------------------- PROFILE ---------------------------- //

app.post("/api/profile", verifyToken, async (req, res) => {
  console.log("=== INÍCIO DA ROTA POST /api/dietas ===");
  console.log("Timestamp:", new Date().toISOString());
  console.log("User ID:", req.userId);

  // Log detalhado dos dados recebidos do frontend
  console.log("--- DADOS RECEBIDOS DO FRONTEND ---");
  console.log("Headers:", JSON.stringify(req.headers, null, 2));
  console.log("Body completo:", JSON.stringify(req.body, null, 2));

  const userId = req.userId;
  const {
    nome,
    imageurl,
    categoria,
    calorias,
    tempo_preparo,
    gordura,
    proteina,
    carboidratos,
  } = req.body;
  const descricao = req.body.descricao ?? req.body.descripcion ?? null;

  // Log dos dados extraá­dos
  console.log("--- DADOS EXTRAáDOS ---");
  console.log("Nome:", nome);
  console.log("Descriçáo:", descricao);
  console.log("Image URL:", imageurl);
  console.log("Categoria:", categoria);
  console.log("Calorias:", calorias);
  console.log("Tempo de preparo:", tempo_preparo);
  console.log("Gordura:", gordura);
  console.log("Proteá­na:", proteina);
  console.log("Carboidratos:", carboidratos);

  // Validaçáo com logs detalhados
  console.log("--- VALIDAá‡áƒO DOS DADOS ---");
  const validationErrors = [];

  if (!nome) {
    validationErrors.push("Nome á© obrigatá³rio");
    console.log("âŒ ERRO: Nome ná£o fornecido");
  } else {
    console.log("âœ… Nome vá¡lido:", nome);
  }

  if (!descricao) {
    validationErrors.push("Descriçáo á© obrigatá³ria");
    console.log("âŒ ERRO: Descriçáo ná£o fornecida");
  } else {
    console.log("âœ… Descriçáo vá¡lida:", descricao.substring(0, 50) + "...");
  }

  if (!imageurl) {
    validationErrors.push("URL da imagem á© obrigatá³ria");
    console.log("âŒ ERRO: URL da imagem ná£o fornecida");
  } else {
    console.log("âœ… URL da imagem vá¡lida:", imageurl);
  }

  if (!categoria) {
    validationErrors.push("Categoria á© obrigatá³ria");
    console.log("âŒ ERRO: Categoria ná£o fornecida");
  } else {
    console.log("âœ… Categoria vá¡lida:", categoria);
  }

  if (validationErrors.length > 0) {
    console.log("--- FALHA NA VALIDAá‡áƒO ---");
    console.log("Erros encontrados:", validationErrors);
    console.log("=== FIM DA ROTA POST /api/dietas (ERRO 400) ===");
    return res.status(400).json({
      error: "Dados obrigatá³rios ná£o fornecidos.",
      details: validationErrors,
    });
  }

  console.log("âœ… Todas as validaá§áµes passaram");

  try {
    console.log("--- BUSCANDO DADOS DO AUTOR ---");
    console.log("Buscando usuá¡rio com ID:", userId);

    const [author] =
      await sql`SELECT nome, username, email FROM usuarios WHERE id_us = ${userId}`;

    if (!author) {
      console.log("âŒ ERRO: Usuá¡rio autor ná£o encontrado no banco de dados");
      console.log("=== FIM DA ROTA POST /api/dietas (ERRO 404) ===");
      return res.status(404).json({ error: "Usuá¡rio autor ná£o encontrado." });
    }

    console.log("âœ… Autor encontrado:", {
      nome: author.nome,
      username: author.username,
      email: author.email,
    });

    const authorName = author.nome || author.username || null;
    const authorAvatarUrl = getGravatarUrl(author.email);

    console.log("--- PREPARANDO DADOS PARA INSERá‡áƒO ---");
    console.log("Nome do autor:", authorName);
    console.log("Avatar URL do autor:", authorAvatarUrl);

    console.log("--- EXECUTANDO INSERT NO BANCO DE DADOS ---");
    const [newDieta] = await sql`
      INSERT INTO dietas (
        id_us, nome, descricao, imageurl, calorias, tempo_preparo,
        gordura, proteina, carboidratos, nome_autor, avatar_autor_url,
        createdat, updatedat, categoria
      )
      VALUES (
        ${userId}, ${nome}, ${descricao}, ${imageurl}, ${calorias || null},
        ${tempo_preparo || null}, ${gordura || null}, ${proteina || null},
        ${carboidratos || null}, ${authorName || null}, ${authorAvatarUrl || null},
        ${new Date()}, ${new Date()}, ${categoria}
      )
      RETURNING *;
    `;

    console.log("âœ… Dieta inserida com sucesso no banco de dados");
    console.log("--- DADOS DA DIETA CRIADA ---");
    console.log("ID da dieta:", newDieta.id_dieta);
    console.log("Nome:", newDieta.nome);
    console.log("Categoria:", newDieta.categoria);
    console.log("Data de criaçáo:", newDieta.createdat);

    console.log("--- RESPOSTA DE SUCESSO ---");
    console.log("Status: 201 - Created");
    console.log("=== FIM DA ROTA POST /api/dietas (SUCESSO) ===");

    res.status(201).json({
      message: "Dieta criada com sucesso!",
      data: newDieta,
    });
  } catch (error) {
    console.log("--- ERRO DURANTE A EXECUá‡áƒO ---");
    console.error("âŒ ERRO ao criar dieta:", error);
    console.log("Tipo do erro:", error.constructor.name);
    console.log("Cá³digo do erro:", error.code);
    console.log("Mensagem do erro:", error.message);
    console.log("Stack trace:", error.stack);

    console.log("--- RESPOSTA DE ERRO ---");
    console.log("Status: 500 - Internal Server Error");
    console.log("=== FIM DA ROTA POST /api/dietas (ERRO 500) ===");

    res.status(500).json({
      error: "Erro interno do servidor ao criar dieta.",
      details: error.message,
    });
  }
});

app.get("/api/profile", verifyToken, async (req, res) => {

  const userId = req.userId;
  const { categoria } = req.query;

  try {
    let query = sql`SELECT id_us, nome, descricao, imageurl, calorias, tempo_preparo, gordura, proteina, carboidratos, nome_autor, avatar_autor_url, createdat, updatedat, categoria, id_dieta FROM dietas WHERE id_us = ${userId}`;

    if (categoria) {
      query = sql`${query} AND categoria = ${categoria}`;
    }

    query = sql`${query} ORDER BY createdat DESC;`;

    const dietas = await query;
    res.status(200).json({ data: dietas });
  } catch (error) {
    console.error("Erro ao listar dietas:", error);
    res.status(500).json({
      error: "Erro interno do servidor ao listar dietas.",
      details: error.message,
    });
  }
});

app.put("/api/profile/:id_profile", verifyToken, async (req, res) => {

  const userId = req.userId;
  const { id_dieta } = req.params;
  const {
    nome,
    descricao,
    imageurl,
    categoria,
    calorias,
    tempo_preparo,
    gordura,
    proteina,
    carboidratos,
    nome_autor,
    avatar_autor_url,
  } = req.body;

  if (!nome || !descricao || !imageurl || !categoria) {
    return res
      .status(400)
      .json({ error: "Nome, descriçáo, imagem e categoria sá£o obrigatá³rios." });
  }

  try {
    const [updatedDieta] = await sql`
      UPDATE dietas
      SET
        nome = ${nome},
        descricao = ${descricao},
        imageurl = ${imageurl},
        calorias = COALESCE(${calorias || null}, calorias),
        tempo_preparo = COALESCE(${tempo_preparo || null}, tempo_preparo),
        gordura = COALESCE(${gordura || null}, gordura),
        proteina = COALESCE(${proteina || null}, proteina),
        carboidratos = COALESCE(${carboidratos || null}, carboidratos),
        nome_autor = COALESCE(${nome_autor || null}, nome_autor),
        avatar_autor_url = COALESCE(${avatar_autor_url || null}, avatar_autor_url),
        categoria = ${categoria},
        updatedat = ${new Date()}
      WHERE id_dieta = ${id_dieta} AND id_us = ${userId}
      RETURNING *;
    `;

    if (!updatedDieta) {
      return res.status(404).json({
        error: "Dieta ná£o encontrada ou vocáª ná£o tem permissá£o para editá¡-la.",
      });
    }
    res
      .status(200)
      .json({ message: "Dieta atualizada com sucesso!", data: updatedDieta });
  } catch (error) {
    console.error("Erro ao editar dieta:", error);
    res.status(500).json({
      error: "Erro interno do servidor ao editar dieta.",
      details: error.message,
    });
  }
});

app.delete("/api/profile/:id_profile", verifyToken, async (req, res) => {

  const userId = req.userId;
  const { id_dieta } = req.params;

  try {
    const [deletedDieta] = await sql`
      DELETE FROM dietas
      WHERE id_dieta = ${id_dieta} AND id_us = ${userId}
      RETURNING *;
    `;

    if (!deletedDieta) {
      return res.status(404).json({
        error: "Dieta ná£o encontrada ou vocáª ná£o tem permissá£o para excluá­-la.",
      });
    }
    res.status(200).json({ message: "Dieta excluá­da com sucesso!" });
  } catch (error) {
    console.error("Erro ao excluir dieta:", error);
    res.status(500).json({
      error: "Erro interno do servidor ao excluir dieta.",
      details: error.message,
    });
  }
});

// -------------------------------- COMUNIDADES ---------------------------- //

app.get("/api/comunidades", verifyToken, async (req, res) => {

  const userId = req.userId;
  const { categoria } = req.query;

  try {
    let query = sql`
      SELECT 
        id_comunidade, 
        nome, 
        descricao, 
        imageurl, 
        participantes, 
        max_participantes, 
        categoria, 
        tipo_comunidade,
        duracao,
        calorias,
        data_evento,
        faixa_etaria,
        premiacao,
        local_inicio,
        local_fim,
        telefone_contato
      FROM comunidades
    `;

    if (categoria && categoria !== "Todas") {
      query = sql`${query} WHERE categoria = ${categoria}`;
    }

    query = sql`${query} ORDER BY createdat DESC`;

    const comunidades = await query;
    res.status(200).json({ data: comunidades });
  } catch (error) {
    console.error("Erro ao listar comunidades:", error);
    res.status(500).json({
      error: "Erro interno do servidor ao listar comunidades.",
      details: error.message,
    });
  }
});

// GET: Detalhes de uma comunidade específica
app.get("/api/comunidades/:id_comunidade", verifyToken, async (req, res) => {

  const { id_comunidade } = req.params;

  try {
    const [comunidade] = await sql`
      SELECT 
        id_comunidade, 
        nome, 
        descricao, 
        imageurl, 
        participantes, 
        max_participantes, 
        categoria, 
        tipo_comunidade, 
        id_us,
        duracao,
        calorias,
        data_evento,
        faixa_etaria,
        premiacao,
        local_inicio,
        local_fim,
        telefone_contato
      FROM comunidades
      WHERE id_comunidade = ${id_comunidade}
    `;

    if (!comunidade) {
      return res.status(404).json({ error: "Comunidade não encontrada." });
    }

    res.status(200).json({ data: comunidade });
  } catch (error) {
    console.error("Erro ao buscar detalhes da comunidade:", error);
    res.status(500).json({
      error: "Erro interno do servidor ao buscar detalhes da comunidade.",
      details: error.message,
    });
  }
});

// POST: Criar nova comunidade
app.post("/api/comunidades", verifyToken, async (req, res) => {

  const userId = req.userId;
  const { nome, descricao, imageurl, max_participantes, categoria, tipo_comunidade } = req.body;

  if (!nome || !categoria) {
    return res.status(400).json({ error: "Nome e categoria sá£o obrigatá³rios." });
  }

  try {
    const [novaComunidade] = await sql`
      INSERT INTO comunidades (
        id_us, nome, descricao, imageurl, participantes, max_participantes, categoria, tipo_comunidade, createdat, updatedat
      )
      VALUES (
        ${userId}, ${nome}, ${descricao}, ${imageurl}, '1', ${max_participantes || 50}, ${categoria}, ${tipo_comunidade || 'Publica'}, NOW(), NOW()
      )
      RETURNING *;
    `;

    res.status(201).json({ message: "Comunidade criada com sucesso!", data: novaComunidade });
  } catch (error) {
    console.error("Erro ao criar comunidade:", error);
    res.status(500).json({
      error: "Erro interno do servidor ao criar comunidade.",
      details: error.message,
    });
  }
});

// POST: Entrar na comunidade (Simulaçáo de incremento)
app.post("/api/comunidades/:id_comunidade/entrar", verifyToken, async (req, res) => {

  const { id_comunidade } = req.params;

  try {
    // Incrementa o contador de participantes (simples, baseado em string/int)
    const [updated] = await sql`
      UPDATE comunidades
      SET participantes = (CAST(COALESCE(NULLIF(participantes, ''), '0') AS INTEGER) + 1)::TEXT, updatedat = NOW()
      WHERE id_comunidade = ${id_comunidade}
      RETURNING *;
    `;

    if (!updated) {
      return res.status(404).json({ error: "Comunidade ná£o encontrada." });
    }

    res.status(200).json({ message: "Vocáª entrou na comunidade!", data: updated });
  } catch (error) {
    console.error("Erro ao entrar na comunidade:", error);
    res.status(500).json({
      error: "Erro interno do servidor ao entrar na comunidade.",
      details: error.message,
    });
  }
});

app.delete("/api/comunidades/:id_comunidade", verifyToken, async (req, res) => {

  const userId = req.userId;
  const { id_comunidade } = req.params;

  try {
    const [deletedCommunity] = await sql`
      DELETE FROM comunidades
      WHERE id_comunidade = ${id_comunidade} AND id_us = ${userId}
      RETURNING *;
    `;

    if (!deletedCommunity) {
      return res.status(404).json({
        error: "Comunidade ná£o encontrada ou vocáª ná£o tem permissá£o para excluá­-la.",
      });
    }
    res.status(200).json({ message: "Comunidade excluá­da com sucesso!" });
  } catch (error) {
    console.error("Erro ao excluir comunidade:", error);
    res.status(500).json({
      error: "Erro interno do servidor ao excluir comunidade.",
      details: error.message,
    });
  }
});

// -------------------------------- ACADEMIAS PARCEIRAS ---------------------------- //

// GET: Listar todas as academias ativas
app.get("/api/academias", verifyToken, async (req, res) => {
  try {
    const academias = await sql`
      SELECT 
        id_academia,
        nome,
        rating,
        total_avaliacoes,
        endereco_completo,
        rua,
        numero,
        bairro,
        cidade,
        estado,
        cep,
        latitude,
        longitude,
        telefone,
        whatsapp,
        ativo
      FROM academias
      WHERE ativo = TRUE
      ORDER BY rating DESC, total_avaliacoes DESC
    `;

    res.status(200).json({ data: academias });
  } catch (error) {
    console.error("Erro ao listar academias:", error);
    res.status(500).json({
      error: "Erro interno do servidor ao listar academias.",
      details: error.message,
    });
  }
});

// GET: Buscar academias próximas (usando fórmula Haversine)
// IMPORTANTE: Esta rota deve vir ANTES de /academias/:id_academia
app.get("/api/academias/nearby", verifyToken, async (req, res) => {
  const { lat, lng, raio = 10 } = req.query;

  if (!lat || !lng) {
    return res.status(400).json({
      error: "Parâmetros 'lat' e 'lng' são obrigatórios."
    });
  }

  const latitude = parseFloat(lat);
  const longitude = parseFloat(lng);
  const raioKm = parseFloat(raio);

  try {
    // Fórmula Haversine para calcular distância usando subquery
    const specialty = req.query.specialty;

    let academias;
    if (specialty) {
      // Filtrar por academias que possuem personais com a especialidade selecionada
      academias = await sql`
        SELECT * FROM (
          SELECT DISTINCT
            a.id_academia,
            a.nome,
            a.rating,
            a.total_avaliacoes,
            a.endereco_completo,
            a.latitude,
            a.longitude,
            a.telefone,
            a.whatsapp,
            (
              6371 * acos(
                LEAST(1, GREATEST(-1, 
                  cos(radians(${latitude})) * 
                  cos(radians(a.latitude)) * 
                  cos(radians(a.longitude) - radians(${longitude})) + 
                  sin(radians(${latitude})) * 
                  sin(radians(a.latitude))
                ))
              )
            ) AS distancia_km
          FROM academias a
          JOIN gym_trainers gt ON gt.gym_id = a.id_academia
          JOIN usuarios u ON gt.personal_id = u.id_us
          LEFT JOIN personal_profiles pp ON pp.id_trainer = u.id_us
          WHERE a.ativo = TRUE 
            AND gt.status = 'active'
            AND (
              ${specialty} = ANY(u.especialidades) 
              OR ${specialty} = ANY(pp.especialidades)
            )
        ) AS academias_com_distancia
        WHERE distancia_km <= ${raioKm}
        ORDER BY distancia_km ASC
      `;
    } else {
      academias = await sql`
        SELECT * FROM (
          SELECT 
            id_academia,
            nome,
            rating,
            total_avaliacoes,
            endereco_completo,
            rua,
            numero,
            bairro,
            cidade,
            estado,
            cep,
            latitude,
            longitude,
            telefone,
            whatsapp,
            (
              6371 * acos(
                LEAST(1, GREATEST(-1, 
                  cos(radians(${latitude})) * 
                  cos(radians(latitude)) * 
                  cos(radians(longitude) - radians(${longitude})) + 
                  sin(radians(${latitude})) * 
                  sin(radians(latitude))
                ))
              )
            ) AS distancia_km
          FROM academias
          WHERE ativo = TRUE
        ) AS academias_com_distancia
        WHERE distancia_km <= ${raioKm}
        ORDER BY distancia_km ASC
      `;
    }

    res.status(200).json({ data: academias });
  } catch (error) {
    console.error("Erro ao buscar academias próximas:", error);
    res.status(500).json({
      error: "Erro interno do servidor ao buscar academias próximas.",
      details: error.message,
    });
  }
});

// Rota para obter treinos filtrados por especialidade
app.get("/api/treinos", verifyToken, async (req, res) => {
  const { specialty } = req.query;
  try {
    let treinos;
    if (specialty) {
      treinos = await sql`
        SELECT * FROM conteudo_treinos 
        WHERE specialty = ${specialty}
        ORDER BY created_at DESC
      `;
    } else {
      treinos = await sql`
        SELECT * FROM conteudo_treinos 
        ORDER BY created_at DESC
      `;
    }
    res.status(200).json({ data: treinos });
  } catch (err) {
    console.error("Erro ao carregar treinos:", err);
    res.status(500).json({
      error: "Erro ao carregar treinos",
      details: err.message,
      stack: err.stack
    });
  }
});

// GET: Detalhes de uma academia específica
app.get("/api/academias/:id_academia", verifyToken, async (req, res) => {
  const { id_academia } = req.params;

  try {
    const [academia] = await sql`
      SELECT 
        id_academia,
        nome,
        rating,
        total_avaliacoes,
        endereco_completo,
        rua,
        numero,
        bairro,
        cidade,
        estado,
        cep,
        latitude,
        longitude,
        telefone,
        whatsapp,
        ativo
      FROM academias
      WHERE id_academia = ${id_academia} AND ativo = TRUE
    `;

    if (!academia) {
      return res.status(404).json({ error: "Academia não encontrada." });
    }

    res.status(200).json({ data: academia });
  } catch (error) {
    console.error("Erro ao buscar detalhes da academia:", error);
    res.status(500).json({
      error: "Erro interno do servidor ao buscar detalhes da academia.",
      details: error.message,
    });
  }
});

// -------------------------------- DADOS DE CALORIAS ---------------------------- //

// GET: Buscar dados de calorias
app.get("/api/dados/calories", verifyToken, async (req, res) => {
  console.log("=== INáCIO DA ROTA GET /api/dados/calories ===");
  console.log("Timestamp:", new Date().toISOString());
  console.log("User ID:", req.userId);

  const userId = req.userId;
  const { timeframe = "1d" } = req.query;

  try {
    let startDate = new Date();
    let endDate = new Date();
    let groupByFormat = "day";

    // Define o intervalo de datas baseado no timeframe
    switch (timeframe) {
      case "1d":
        startDate.setHours(0, 0, 0, 0);
        groupByFormat = "hour";
        break;
      case "1s":
        startDate.setDate(startDate.getDate() - 7);
        groupByFormat = "day";
        break;
      case "1m":
        startDate.setDate(startDate.getDate() - 30);
        groupByFormat = "day";
        break;
      case "1a":
        startDate.setFullYear(startDate.getFullYear() - 1);
        groupByFormat = "month";
        break;
      case "Tudo":
        startDate.setFullYear(startDate.getFullYear() - 10);
        groupByFormat = "month";
        break;
      default:
        startDate.setDate(startDate.getDate() - 7);
    }

    console.log("Buscando dados de calorias de", startDate, "atá©", endDate);

    // Busca os dados de calorias do usuá¡rio
    const caloriesData = await sql`
      SELECT 
        id_dado,
        calories,
        timestamp,
        DATE_TRUNC(${groupByFormat}, timestamp) as period
      FROM dados_saude
      WHERE id_us = ${userId}
        AND timestamp >= ${startDate}
        AND timestamp <= ${endDate}
        AND calories IS NOT NULL
      ORDER BY timestamp ASC
    `;

    console.log(`âœ… Encontrados ${caloriesData.length} registros de calorias`);

    // Agrupa dados se necessá¡rio
    const groupedData = {};
    caloriesData.forEach((item) => {
      const key = item.period.toISOString();
      if (!groupedData[key]) {
        groupedData[key] = {
          date: item.period.toISOString(),
          calories: 0,
          count: 0,
          timestamp: item.period.toISOString(),
        };
      }
      groupedData[key].calories += item.calories;
      groupedData[key].count += 1;
    });

    // Calcula a má©dia de calorias por perá­odo
    const processedData = Object.values(groupedData).map((item) => ({
      date: item.date,
      calories: Math.round(item.calories / item.count),
      timestamp: item.timestamp,
    }));

    // Se ná£o houver dados, gera dados mockados
    const data =
      processedData.length > 0
        ? processedData
        : generateMockCaloriesData(timeframe);

    // Calcula estatá­sticas
    const totalCalories = data[data.length - 1]?.calories || 0;
    const dailyGoal = 2000;
    const remainingCalories = Math.max(0, dailyGoal - totalCalories);

    const response = {
      totalCalories,
      remainingCalories,
      dailyGoal,
      data,
    };

    console.log("--- RESPOSTA DE SUCESSO ---");
    console.log("Total de calorias:", totalCalories);
    console.log("Calorias restantes:", remainingCalories);
    console.log("Total de pontos no grá¡fico:", data.length);
    console.log("=== FIM DA ROTA GET /api/dados/calories (SUCESSO) ===");

    res.status(200).json(response);
  } catch (error) {
    console.error("âŒ Erro ao buscar dados de calorias:", error);
    console.log("=== FIM DA ROTA GET /api/dados/calories (ERRO 500) ===");
    res.status(500).json({
      error: "Erro interno do servidor ao buscar dados de calorias.",
      details: error.message,
    });
  }
});

// POST: Salvar dados de calorias
app.post("/api/dados/calories", verifyToken, async (req, res) => {
  console.log("=== INáCIO DA ROTA POST /api/dados/calories ===");
  console.log("Timestamp:", new Date().toISOString());
  console.log("User ID:", req.userId);
  console.log("Body:", req.body);

  const userId = req.userId;
  const { calories, timestamp } = req.body;

  if (!calories) {
    console.log("âŒ Erro: Calorias ná£o fornecidas");
    return res.status(400).json({ error: "Calorias sá£o obrigatá³rias." });
  }

  try {
    const recordTimestamp = timestamp ? new Date(timestamp) : new Date();

    const [newRecord] = await sql`
      INSERT INTO dados_saude (
        id_us, calories, timestamp, created_at, updated_at
      )
      VALUES (
        ${userId}, ${calories}, ${recordTimestamp}, ${new Date()}, ${new Date()}
      )
      RETURNING *;
    `;

    console.log("âœ… Registro de calorias criado com sucesso");
    console.log("ID do registro:", newRecord.id_dado);
    console.log("=== FIM DA ROTA POST /api/dados/calories (SUCESSO) ===");

    res.status(201).json({
      message: "Dados de calorias salvos com sucesso!",
      data: newRecord,
    });
  } catch (error) {
    console.error("âŒ Erro ao salvar dados de calorias:", error);
    console.log("=== FIM DA ROTA POST /api/dados/calories (ERRO 500) ===");
    res.status(500).json({
      error: "Erro interno do servidor ao salvar dados de calorias.",
      details: error.message,
    });
  }
});

// -------------------------------- WEAR OS DEVICES ---------------------------- //

// POST: Registrar automaticamente um dispositivo Wear OS âœ…
app.post("/api/wearos/register", verifyToken, async (req, res) => {
  console.log("=== INáCIO DA ROTA POST /api/wearos/register-device ===");
  console.log("User ID:", req.userId);
  console.log("Body recebido:", req.body);

  const userId = req.userId;
  const {
    deviceName,
    deviceModel,
    deviceType = "Wear OS",
    deviceVersion,
    tokenAcesso
  } = req.body;

  if (!deviceName || !deviceModel) {
    console.log("âŒ Erro: Nome e modelo do dispositivo sá£o obrigatá³rios");
    return res.status(400).json({
      error: "Nome e modelo do dispositivo sá£o obrigatá³rios."
    });
  }

  try {
    // Verificar se já¡ existe um dispositivo com este modelo para o usuá¡rio
    const existingDevice = await sql`
      SELECT id_disp FROM dispositivos
      WHERE id_us = ${userId}
      AND modelo = ${deviceModel}
      AND tipo = ${deviceType}
    `;

    if (existingDevice.length > 0) {
      console.log("âœ… Dispositivo já¡ registrado para o usuá¡rio:", existingDevice[0].id_disp);
      return res.status(200).json({
        message: "Dispositivo já¡ estava registrado",
        deviceId: existingDevice[0].id_disp,
        device: existingDevice[0]
      });
    }

    // Inserir novo dispositivo na tabela (usando os nomes de coluna corretos da tabela existente)
    const [newDevice] = await sql`
      INSERT INTO dispositivos (
        id_us, nome, tipo, status, modelo, versao_watchos, token_acesso, createdat, updatedat
      )
      VALUES (
        ${userId}, ${deviceName}, ${deviceType}, 'ativo', ${deviceModel},
        ${deviceVersion || null}, ${tokenAcesso || null}, ${new Date()}, ${new Date()}
      )
      RETURNING *;
    `;

    console.log("âœ… Dispositivo registrado com sucesso:", newDevice.id_disp);
    console.log("=== FIM DA ROTA POST /api/wearos/register-device ===");

    res.status(201).json({
      message: "Dispositivo Wear OS registrado com sucesso!",
      deviceId: newDevice.id_disp,
      device: newDevice
    });
  } catch (error) {
    console.error("âŒ Erro ao registrar dispositivo Wear OS:", error);
    console.log("=== FIM DA ROTA POST /api/wearos/register-device (ERRO) ===");
    res.status(500).json({
      error: "Erro interno do servidor ao registrar dispositivo.",
      details: error.message
    });
  }
});

// GET: Listar dispositivos Wear OS do usuá¡rio âœ…
app.get("/api/wearos/devices", verifyToken, async (req, res) => {
  console.log("=== INáCIO DA ROTA GET /api/wearos/devices ===");
  console.log("User ID:", req.userId);

  const userId = req.userId;

  try {
    const devices = await sql`
      SELECT id_disp, id_us, nome, tipo, status, modelo, versao_watchos, createdat, updatedat
      FROM dispositivos
      WHERE id_us = ${userId}
      AND tipo = 'Wear OS'
      ORDER BY createdat DESC;
    `;

    console.log(`âœ… Encontrados ${devices.length} dispositivos Wear OS`);
    console.log("=== FIM DA ROTA GET /api/wearos/devices ===");

    res.status(200).json({
      message: "Dispositivos Wear OS listados com sucesso!",
      devices: devices,
      count: devices.length
    });
  } catch (error) {
    console.error("âŒ Erro ao listar dispositivos Wear OS:", error);
    console.log("=== FIM DA ROTA GET /api/wearos/devices (ERRO) ===");
    res.status(500).json({
      error: "Erro interno do servidor ao listar dispositivos.",
      details: error.message
    });
  }
});

// GET: Verificar se o usuá¡rio tem dispositivos Wear OS registrados âœ…
app.get("/api/wearos/devicesON", verifyToken, async (req, res) => {
  console.log("=== INáCIO DA ROTA GET /api/wearos/has-devices ===");
  console.log("User ID:", req.userId);

  const userId = req.userId;

  try {
    const result = await sql`
      SELECT COUNT(*) as device_count
      FROM dispositivos
      WHERE id_us = ${userId}
      AND tipo = 'Wear OS';
    `;

    const hasDevices = result[0].device_count > 0;

    console.log(`âœ… Usuá¡rio ${userId} tem ${result[0].device_count} dispositivos Wear OS`);
    console.log("=== FIM DA ROTA GET /api/wearos/has-devices ===");

    res.status(200).json({
      hasDevices: hasDevices,
      deviceCount: parseInt(result[0].device_count)
    });
  } catch (error) {
    console.error("âŒ Erro ao verificar dispositivos Wear OS:", error);
    console.log("=== FIM DA ROTA GET /api/wearos/has-devices (ERRO) ===");
    res.status(500).json({
      error: "Erro interno do servidor ao verificar dispositivos.",
      details: error.message
    });
  }
});

// POST: Registrar dados de saáºde do Wear OS
app.post("/api/wearos/health", verifyToken, async (req, res) => {
  console.log("=== INáCIO DA ROTA POST /api/wearos/health-data ===");
  console.log("User ID:", req.userId);
  console.log("Body recebido:", JSON.stringify(req.body, null, 2));

  const userId = req.userId;
  const {
    deviceId,
    heartRate,
    bloodPressure,
    oxygenSaturation,
    timestamp = new Date(),
    latitude,
    longitude
  } = req.body;

  if (!deviceId) {
    console.log("âŒ Erro: ID do dispositivo á© obrigatá³rio");
    return res.status(400).json({
      error: "ID do dispositivo á© obrigatá³rio."
    });
  }

  // Verificar se o dispositivo pertence ao usuá¡rio
  const deviceCheck = await sql`
    SELECT id_disp FROM dispositivos
    WHERE id_disp = ${deviceId}
    AND id_us = ${userId}
  `;

  if (deviceCheck.length === 0) {
    console.log("âŒ Erro: Dispositivo ná£o encontrado ou ná£o pertence ao usuá¡rio");
    return res.status(404).json({
      error: "Dispositivo ná£o encontrado ou ná£o pertence ao usuá¡rio."
    });
  }

  try {
    const healthRecords = [];

    // Registrar dados de frequáªncia cardá­aca (usando tabela healthkit)
    if (heartRate !== null && heartRate !== undefined) {
      const [heartRateRecord] = await sql`
        INSERT INTO healthkit (
          id_disp, id_us, tipo_dado, valor, unidade, createdat, updatedat
        )
        VALUES (
          ${deviceId}, ${userId}, 'heart_rate', ${heartRate.toString()}, 'bpm',
          ${timestamp}, ${new Date()}
        )
        RETURNING *;
      `;
      healthRecords.push(heartRateRecord);
    }

    // Registrar dados de pressá£o arterial (usando tabela healthkit)
    if (bloodPressure !== null && bloodPressure !== undefined) {
      const [pressureRecord] = await sql`
        INSERT INTO healthkit (
          id_disp, id_us, tipo_dado, valor, unidade, createdat, updatedat
        )
        VALUES (
          ${deviceId}, ${userId}, 'blood_pressure', ${bloodPressure.toString()}, 'mmHg',
          ${timestamp}, ${new Date()}
        )
        RETURNING *;
      `;
      healthRecords.push(pressureRecord);
    }

    // Registrar dados de oxigáªnio (usando tabela healthkit)
    if (oxygenSaturation !== null && oxygenSaturation !== undefined) {
      const [oxygenRecord] = await sql`
        INSERT INTO healthkit (
          id_disp, id_us, tipo_dado, valor, unidade, createdat, updatedat
        )
        VALUES (
          ${deviceId}, ${userId}, 'oxygen_saturation', ${oxygenSaturation.toString()}, 'SpO2',
          ${timestamp}, ${new Date()}
        )
        RETURNING *;
      `;
      healthRecords.push(oxygenRecord);
    }

    console.log(`âœ… ${healthRecords.length} registros de saáºde criados para o dispositivo ${deviceId}`);
    console.log("=== FIM DA ROTA POST /api/wearos/health-data ===");

    res.status(201).json({
      message: "Dados de saáºde registrados com sucesso!",
      records: healthRecords,
      count: healthRecords.length
    });
  } catch (error) {
    console.error("âŒ Erro ao registrar dados de saáºde:", error);
    console.log("=== FIM DA ROTA POST /api/wearos/health-data (ERRO) ===");
    res.status(500).json({
      error: "Erro interno do servidor ao registrar dados de saáºde.",
      details: error.message
    });
  }
});

// GET: Obter dados de saáºde mais recentes de dispositivos Wear OS âœ…
app.get("/api/wearos/health", verifyToken, async (req, res) => {
  console.log("=== INáCIO DA ROTA GET /api/wearos/latest-health-data ===");
  console.log("User ID:", req.userId);

  const userId = req.userId;

  try {
    // Primeiro, obter os dispositivos Wear OS do usuá¡rio
    const devices = await sql`
      SELECT id_disp FROM dispositivos
      WHERE id_us = ${userId}
      AND tipo = 'Wear OS'
      AND status = 'ativo';
    `;

    if (devices.length === 0) {
      console.log("âœ… Nenhum dispositivo Wear OS encontrado para o usuá¡rio");
      return res.status(200).json({
        message: "Nenhum dispositivo Wear OS registrado",
        heartRate: null,
        pressure: null,
        oxygen: null,
        devices: []
      });
    }

    // Obter os dados de saáºde mais recentes para cada tipo da tabela healthkit
    const [heartRateData, pressureData, oxygenData] = await Promise.all([
      // Frequáªncia cardá­aca
      sql`
        SELECT h.valor, h.createdat, d.nome as device_name
        FROM healthkit h
        JOIN dispositivos d ON h.id_disp = d.id_disp
        WHERE h.id_disp IN (${sql.join(devices.map(d => d.id_disp), ',')})
          AND h.tipo_dado = 'heart_rate'
        ORDER BY h.createdat DESC
        LIMIT 1;
      `,

      // Pressá£o arterial
      sql`
        SELECT h.valor, h.createdat, d.nome as device_name
        FROM healthkit h
        JOIN dispositivos d ON h.id_disp = d.id_disp
        WHERE h.id_disp IN (${sql.join(devices.map(d => d.id_disp), ',')})
          AND h.tipo_dado = 'blood_pressure'
        ORDER BY h.createdat DESC
        LIMIT 1;
      `,

      // Oxigáªnio (SpO2)
      sql`
        SELECT h.valor, h.createdat, d.nome as device_name
        FROM healthkit h
        JOIN dispositivos d ON h.id_disp = d.id_disp
        WHERE h.id_disp IN (${sql.join(devices.map(d => d.id_disp), ',')})
          AND h.tipo_dado = 'oxygen_saturation'
        ORDER BY h.createdat DESC
        LIMIT 1;
      `
    ]);

    const result = {
      message: "Dados de saáºde mais recentes recuperados",
      heartRate: heartRateData[0]?.valor ? parseFloat(heartRateData[0].valor) : null,
      pressure: pressureData[0]?.valor ? parseFloat(pressureData[0].valor) : null,
      oxygen: oxygenData[0]?.valor ? parseFloat(oxygenData[0].valor) : null,
      lastUpdate: {
        heartRate: heartRateData[0]?.createdat || null,
        pressure: pressureData[0]?.createdat || null,
        oxygen: oxygenData[0]?.createdat || null,
      },
      devices: devices.map(d => d.id_disp),
      deviceCount: devices.length
    };

    console.log("âœ… Dados de saáºde recuperados com sucesso");
    console.log("Heart Rate:", result.heartRate);
    console.log("Pressure:", result.pressure);
    console.log("Oxygen:", result.oxygen);
    console.log("=== FIM DA ROTA GET /api/wearos/latest-health-data ===");

    res.status(200).json(result);
  } catch (error) {
    console.error("âŒ Erro ao obter dados de saáºde:", error);
    console.log("=== FIM DA ROTA GET /api/wearos/latest-health-data (ERRO) ===");
    res.status(500).json({
      error: "Erro interno do servidor ao obter dados de saáºde.",
      details: error.message
    });
  }
});

// GET: Obter histá³rico de dados de saáºde do Wear OS âœ…
app.get("/api/wearos/health-history", verifyToken, async (req, res) => {
  console.log("=== INáCIO DA ROTA GET /api/wearos/health-history ===");
  console.log("User ID:", req.userId);
  const { timeframe = "1d", dataType = "all" } = req.query;

  const userId = req.userId;

  try {
    // Obter dispositivos Wear OS do usuá¡rio
    const devices = await sql`
      SELECT id_disp FROM dispositivos
      WHERE id_us = ${userId}
      AND tipo = 'Wear OS'
      AND status = 'ativo';
    `;

    if (devices.length === 0) {
      return res.status(200).json({
        message: "Nenhum dispositivo Wear OS registrado",
        data: [],
        totalRecords: 0
      });
    }

    let startDate = new Date();
    // Define o intervalo de datas baseado no timeframe
    switch (timeframe) {
      case "1d":
        startDate.setDate(startDate.getDate() - 1);
        break;
      case "1s":
        startDate.setDate(startDate.getDate() - 7);
        break;
      case "1m":
        startDate.setDate(startDate.getDate() - 30);
        break;
      case "1a":
        startDate.setDate(startDate.getDate() - 365);
        break;
      default:
        startDate.setDate(startDate.getDate() - 7);
    }

    // Construir a query base
    let query = sql`
      SELECT h.*, d.nome as device_name
      FROM healthkit h
      JOIN dispositivos d ON h.id_disp = d.id_disp
      WHERE h.id_disp IN (${sql.join(devices.map(d => d.id_disp), ',')})
        AND h.createdat >= ${startDate}
    `;

    // Filtrar por tipo de dado se especificado
    if (dataType !== "all") {
      query = sql`${query} AND h.tipo_dado = ${dataType}`;
    }

    query = sql`${query} ORDER BY h.createdat DESC`;

    const healthHistory = await query;

    console.log(`âœ… Encontrados ${healthHistory.length} registros de saáºde`);
    console.log("Timeframe:", timeframe, "DataType:", dataType);
    console.log("=== FIM DA ROTA GET /api/wearos/health-history ===");

    res.status(200).json({
      message: "Histá³rico de dados de saáºde recuperado",
      data: healthHistory,
      totalRecords: healthHistory.length,
      timeframe: timeframe,
      dataType: dataType
    });
  } catch (error) {
    console.error("âŒ Erro ao obter histá³rico de saáºde:", error);
    console.log("=== FIM DA ROTA GET /api/wearos/health-history (ERRO) ===");
    res.status(500).json({
      error: "Erro interno do servidor ao obter histá³rico de saáºde.",
      details: error.message
    });
  }
});

// PUT: Atualizar status do dispositivo Wear OS
app.put("/api/wearos/status/:deviceId", verifyToken, async (req, res) => {
  console.log("=== INáCIO DA ROTA PUT /api/wearos/device-status/:deviceId ===");
  console.log("User ID:", req.userId);
  console.log("Device ID:", req.params.deviceId);
  console.log("Body:", req.body);

  const userId = req.userId;
  const deviceId = req.params.deviceId;
  const { status } = req.body;

  if (!status) {
    return res.status(400).json({
      error: "Status á© obrigatá³rio."
    });
  }

  if (!['ativo', 'inativo', 'conectando', 'desconectado'].includes(status)) {
    return res.status(400).json({
      error: "Status invá¡lido. Use: ativo, inativo, conectando, desconectado"
    });
  }

  try {
    // Verificar se o dispositivo pertence ao usuá¡rio
    const deviceCheck = await sql`
      SELECT id_disp FROM dispositivos
      WHERE id_disp = ${deviceId}
      AND id_us = ${userId}
    `;

    if (deviceCheck.length === 0) {
      return res.status(404).json({
        error: "Dispositivo ná£o encontrado ou ná£o pertence ao usuá¡rio."
      });
    }

    const [updatedDevice] = await sql`
      UPDATE dispositivos
      SET status = ${status}, updatedat = ${new Date()}
      WHERE id_disp = ${deviceId}
      RETURNING *;
    `;

    console.log(`âœ… Status do dispositivo ${deviceId} atualizado para: ${status}`);
    console.log("=== FIM DA ROTA PUT /api/wearos/device-status/:deviceId ===");

    res.status(200).json({
      message: "Status do dispositivo atualizado com sucesso!",
      device: updatedDevice
    });
  } catch (error) {
    console.error("âŒ Erro ao atualizar status do dispositivo:", error);
    console.log("=== FIM DA ROTA PUT /api/wearos/device-status/:deviceId (ERRO) ===");
    res.status(500).json({
      error: "Erro interno do servidor ao atualizar status do dispositivo.",
      details: error.message
    });
  }
});

// DELETE: Remover dispositivo Wear OS
app.delete("/api/wearos/device/:deviceId", verifyToken, async (req, res) => {
  console.log("=== INáCIO DA ROTA DELETE /api/wearos/device/:deviceId ===");
  console.log("User ID:", req.userId);
  console.log("Device ID:", req.params.deviceId);

  const userId = req.userId;
  const deviceId = req.params.deviceId;

  try {
    // Verificar se o dispositivo pertence ao usuá¡rio
    const deviceCheck = await sql`
      SELECT id_disp FROM dispositivos
      WHERE id_disp = ${deviceId}
      AND id_us = ${userId}
    `;

    if (deviceCheck.length === 0) {
      return res.status(404).json({
        error: "Dispositivo ná£o encontrado ou ná£o pertence ao usuá¡rio."
      });
    }

    // Remover registros de saáºde associados
    await sql`
      DELETE FROM healthkit
      WHERE id_disp = ${deviceId};
    `;

    // Remover o dispositivo
    const [deletedDevice] = await sql`
      DELETE FROM dispositivos
      WHERE id_disp = ${deviceId}
      RETURNING *;
    `;

    console.log(`âœ… Dispositivo ${deviceId} e dados associados removidos`);
    console.log("=== FIM DA ROTA DELETE /api/wearos/device/:deviceId ===");

    res.status(200).json({
      message: "Dispositivo e dados de saáºde associados removidos com sucesso!",
      device: deletedDevice
    });
  } catch (error) {
    console.error("âŒ Erro ao remover dispositivo:", error);
    console.log("=== FIM DA ROTA DELETE /api/wearos/device/:deviceId (ERRO) ===");
    res.status(500).json({
      error: "Erro interno do servidor ao remover dispositivo.",
      details: error.message
    });
  }
});

// GET: Listar agendamentos do usuá¡rio (como cliente ou trainer)
app.get("/api/appointments", verifyToken, async (req, res) => {
  const userId = req.userId;
  const { role = "client" } = req.query; // 'client' ou 'trainer'

  try {
    const [{ exists }] = await sql`SELECT to_regclass('public.agendamentos') IS NOT NULL AS exists`;
    if (!exists) {
      return res.status(501).json({ error: "Sistema de agendamentos ná£o instalado." });
    }

    let appointments;
    if (role === "trainer") {
      // Agendamentos como trainer
      appointments = await sql`
        SELECT 
          a.id_agendamento, a.id_trainer, a.id_usuario, 
          a.data_agendamento, a.hora_inicio, a.hora_fim, 
          a.status, a.notas, a.created_at,
          u.nome as user_name, u.email as user_email, u.avatar_url as user_avatar
        FROM agendamentos a
        JOIN usuarios u ON a.id_usuario = u.id_us
        WHERE a.id_trainer = ${userId}
        ORDER BY a.data_agendamento DESC, a.hora_inicio DESC
        LIMIT 50
      `;
    } else {
      // Agendamentos como cliente
      appointments = await sql`
        SELECT 
          a.id_agendamento, a.id_trainer, a.id_usuario, 
          a.data_agendamento, a.hora_inicio, a.hora_fim, 
          a.status, a.notas, a.created_at,
          u.nome as trainer_name, u.email as trainer_email, u.avatar_url as trainer_avatar,
          CASE WHEN r.id IS NOT NULL THEN true ELSE false END as avaliado
        FROM agendamentos a
        JOIN usuarios u ON a.id_trainer = u.id_us
        LEFT JOIN avaliacoes_treinos r ON a.id_agendamento = r.id_agendamento
        WHERE a.id_usuario = ${userId}
        ORDER BY a.data_agendamento DESC, a.hora_inicio DESC
        LIMIT 50
      `;
    }

    return res.status(200).json({
      data: appointments,
      count: appointments.length
    });
  } catch (err) {
    console.error("Erro em GET /api/appointments", err);
    return res.status(500).json({ error: "Erro ao listar agendamentos." });
  }
});

// GET: Buscar agendamentos de um trainer em uma data especá­fica
app.get("/api/appointments/trainer/:trainerId", async (req, res) => {
  const trainerId = req.params.trainerId;
  const { date } = req.query; // YYYY-MM-DD

  try {
    if (!trainerId || isNaN(parseInt(trainerId, 10))) {
      return res.status(400).json({ error: "ID do trainer invá¡lido." });
    }

    const [{ exists }] = await sql`SELECT to_regclass('public.agendamentos') IS NOT NULL AS exists`;
    if (!exists) {
      return res.status(501).json({ error: "Sistema de agendamentos ná£o instalado." });
    }

    let query = sql`
      SELECT id_agendamento, id_usuario, data_agendamento, 
             hora_inicio, hora_fim, status, notas, created_at,
             (SELECT nome FROM usuarios WHERE id_us = a.id_usuario) as user_name
      FROM agendamentos a
      WHERE id_trainer = ${parseInt(trainerId, 10)}
    `;

    if (date) {
      query = sql`${query} AND data_agendamento = ${date}`;
    }

    query = sql`${query} ORDER BY data_agendamento DESC, hora_inicio ASC`;

    const appointments = await query;

    return res.status(200).json({
      data: appointments,
      count: appointments.length
    });
  } catch (err) {
    console.error("Erro em GET /api/appointments/trainer/:trainerId", err);
    return res.status(500).json({ error: "Erro ao listar agendamentos do trainer." });
  }
});

// PUT: Atualizar agendamento (status, notas, etc)
app.put("/api/appointments/:appointmentId", verifyToken, async (req, res) => {
  const userId = req.userId;
  const appointmentId = req.params.appointmentId;
  const { status, notas } = req.body;

  try {
    const [{ exists }] = await sql`SELECT to_regclass('public.agendamentos') IS NOT NULL AS exists`;
    if (!exists) {
      return res.status(501).json({ error: "Sistema de agendamentos ná£o instalado." });
    }

    // Buscar o agendamento
    const [appointment] = await sql`
      SELECT * FROM agendamentos WHERE id_agendamento = ${appointmentId}
    `;

    if (!appointment) {
      return res.status(404).json({ error: "Agendamento ná£o encontrado." });
    }

    // Verificar permissá£o (trainer ou cliente do agendamento)
    if (appointment.id_trainer !== userId && appointment.id_usuario !== userId) {
      return res.status(403).json({ error: "Sem permissá£o para atualizar este agendamento." });
    }

    const [updated] = await sql`
      UPDATE agendamentos
      SET status = COALESCE(${status || null}, status),
          notas = COALESCE(${notas || null}, notas),
          updated_at = CURRENT_TIMESTAMP
      WHERE id_agendamento = ${appointmentId}
      RETURNING *
    `;

    return res.status(200).json({
      success: true,
      message: "Agendamento atualizado!",
      appointment: updated
    });
  } catch (err) {
    console.error("Erro em PUT /api/appointments/:appointmentId", err);
    return res.status(500).json({ error: "Erro ao atualizar agendamento." });
  }
});

// DELETE: Cancelar agendamento
app.delete("/api/appointments/:appointmentId", verifyToken, async (req, res) => {
  const userId = req.userId;
  const appointmentId = req.params.appointmentId;

  try {
    const [{ exists }] = await sql`SELECT to_regclass('public.agendamentos') IS NOT NULL AS exists`;
    if (!exists) {
      return res.status(501).json({ error: "Sistema de agendamentos ná£o instalado." });
    }

    const [appointment] = await sql`
      SELECT * FROM agendamentos WHERE id_agendamento = ${appointmentId}
    `;

    if (!appointment) {
      return res.status(404).json({ error: "Agendamento ná£o encontrado." });
    }

    // Verificar permissá£o
    if (appointment.id_trainer !== userId && appointment.id_usuario !== userId) {
      return res.status(403).json({ error: "Sem permissá£o para cancelar este agendamento." });
    }

    await sql`
      DELETE FROM agendamentos WHERE id_agendamento = ${appointmentId}
    `;

    return res.status(200).json({
      success: true,
      message: "Agendamento cancelado com sucesso!"
    });
  } catch (err) {
    console.error("Erro em DELETE /api/appointments/:appointmentId", err);
    return res.status(500).json({ error: "Erro ao cancelar agendamento." });
  }
});

// Endpoint de inicializaçáo - criar tabelas de agendamentos se ná£o existirem
app.post("/api/init/agendamentos", async (req, res) => {
  try {
    console.log("[POST /init/agendamentos] Inicializando tabelas de agendamentos...");
    const fs = require("fs");
    const schema = fs.readFileSync("./agendamentos-schema.sql", "utf-8");
    const statements = schema.split(";").filter(s => s.trim());

    // Executar cada instruçáo separadamente, ignorando erros de dependáªncia
    for (const statement of statements) {
      if (statement.trim()) {
        try {
          await sql.unsafe(statement);
          console.log(`âœ“ Executado: ${statement.substring(0, 50)}...`);
        } catch (stmtErr) {
          console.log(`âš  Pulo instruçáo (pode ser dependáªncia): ${stmtErr.message}`);
          console.log(`  Instruçáo: ${statement.trim()}`);
        }
      }
    }

    console.log("[POST /init/agendamentos] Tabelas criadas com sucesso");
    return res.status(200).json({
      success: true,
      message: "Tabelas de agendamentos inicializadas com sucesso"
    });
  } catch (err) {
    console.error("[POST /init/agendamentos] Erro:", err);
    return res.status(500).json({
      error: "Erro ao inicializar tabelas",
      details: err.message
    });
  }
});

// -------------------------------- COMUNIDADES -------------------------------- //

app.get("/api/comunidades", verifyToken, async (req, res) => {
  const userId = req.userId;
  const { categoria } = req.query;

  try {
    let query = sql`
      SELECT 
        id_comunidade, 
        nome, 
        descricao, 
        imageurl, 
        participantes, 
        max_participantes, 
        categoria, 
        tipo_comunidade,
        duracao,
        calorias,
        data_evento,
        faixa_etaria,
        premiacao,
        local_inicio,
        local_fim,
        telefone_contato
      FROM comunidades
    `;

    if (categoria && categoria !== "Todas") {
      query = sql`${query} WHERE categoria = ${categoria}`;
    }

    query = sql`${query} ORDER BY createdat DESC`;

    const comunidades = await query;
    res.status(200).json({ data: comunidades });
  } catch (error) {
    console.error("Erro ao listar comunidades:", error);
    res.status(500).json({
      error: "Erro interno do servidor ao listar comunidades.",
      details: error.message,
    });
  }
});

// ==================== ROTAS DE AGENDAMENTO (APPOINTMENTS) ==================== //

// 1. GET: Disponibilidade
app.get("/api/appointments/availability/:trainerId", async (req, res) => {
  const trainerId = req.params.trainerId;
  const { date } = req.query;

  try {
    if (!trainerId) return res.status(400).json({ error: "ID inválido." });

    const [{ exists: dispExists }] = await sql`SELECT to_regclass('public.disponibilidade_trainer') IS NOT NULL AS exists`;
    if (!dispExists) {
      return res.status(200).json({ available: false, message: "Sem configuração." });
    }

    const availability = await sql`
      SELECT * FROM disponibilidade_trainer
      WHERE id_trainer = ${parseInt(trainerId, 10)} AND ativo = TRUE
      ORDER BY dia_semana ASC, hora_inicio ASC
    `;

    if (!date) return res.status(200).json({ availability });

    // Extrair dia da semana usando UTC para evitar problemas de fuso horário do servidor
    const [year, month, day] = date.split('-').map(Number);
    const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

    console.log(`[GET Availability] Trainer ${trainerId}, Data ${date}, Dia da Semana Calculado: ${dayOfWeek}`);

    const dayAvailability = availability.filter(a => a.dia_semana === dayOfWeek);

    let bookedSlots = [];
    try {
      bookedSlots = await sql`
        SELECT hora_inicio, hora_fim FROM agendamentos
        WHERE id_trainer = ${parseInt(trainerId, 10)}
          AND data_agendamento = ${date}
          AND status IN ('pendente', 'confirmado')
      `;
    } catch (e) { }

    const availableSlots = [];
    dayAvailability.forEach(slot => {
      // Normalizar horários do banco (HH:mm:ss ou HH:mm) para HH:mm
      const startTimeDb = (slot.hora_inicio || "").substring(0, 5);
      const endTimeDb = (slot.hora_fim || "").substring(0, 5);

      if (!startTimeDb || !endTimeDb) return;

      const startH = parseInt(startTimeDb.split(':')[0]);
      const endH = parseInt(endTimeDb.split(':')[0]);

      for (let h = startH; h < endH; h++) {
        const startStr = `${h.toString().padStart(2, '0')}:00`;
        const endStr = `${(h + 1).toString().padStart(2, '0')}:00`;

        const conflict = bookedSlots.some(b => {
          const bStart = (b.hora_inicio || "").substring(0, 5);
          const bEnd = (b.hora_fim || "").substring(0, 5);
          return startStr >= bStart && startStr < bEnd;
        });

        if (!conflict) {
          availableSlots.push({ startTime: startStr, endTime: endStr, available: true });
        }
      }
    });

    // Remover duplicatas de slots
    const uniqueAvailableSlots = availableSlots.filter((slot, index, self) =>
      index === self.findIndex((s) => s.startTime === slot.startTime && s.endTime === slot.endTime)
    );

    return res.status(200).json({
      date,
      available: uniqueAvailableSlots.length > 0,
      availableSlots: uniqueAvailableSlots,
      bookedSlots,
      calculatedDayOfWeek: dayOfWeek
    });
  } catch (err) {
    console.error(`[GET Availability] Erro:`, err);
    return res.status(500).json({ error: "Erro interno ao buscar disponibilidade." });
  }
});

// 2. POST: Criar Agendamento (CORRIGIDO)
// Rota para avaliar um agendamento concluído
app.post("/api/appointments/:id/rate", verifyToken, async (req, res) => {
  const { id } = req.params;
  const { ratingProfessional, ratingTraining, comment, trainerId } = req.body;
  const userId = req.userId;

  console.log(`[RATE] Início - AgendamentoID: ${id}, AutorID: ${userId}`);

  try {
    const numericApptId = parseInt(id, 10);
    const numericTrainerId = parseInt(trainerId || 0, 10);

    // 1. Verificar agendamento
    const [appointment] = await sql`
      SELECT id_agendamento, id_trainer, status FROM agendamentos 
      WHERE id_agendamento = ${numericApptId} 
        AND LOWER(status) IN ('concluido', 'concluído')
    `;

    if (!appointment) {
      console.log(`[RATE] Erro: Agendamento ${id} não encontrado ou não concluído.`);
      return res.status(404).json({ error: "Agendamento não encontrado ou não concluído." });
    }

    const finalTrainerId = numericTrainerId || appointment.id_trainer;
    console.log(`[RATE] Validado. Inserindo na tabela avaliacoes_treinos para trainer: ${finalTrainerId}`);

    // 2. Salvar avaliação na tabela avaliacoes_treinos (que criamos no initDb)
    const [rating] = await sql`
      INSERT INTO avaliacoes_treinos (
        id_agendamento, id_autor, id_destino, nota_profissional, nota_treino, comentario
      ) VALUES (
        ${numericApptId}, ${userId.toString()}, ${finalTrainerId.toString()}, 
        ${parseInt(ratingProfessional, 10)}, ${parseInt(ratingTraining, 10)}, ${comment || ''}
      )
      RETURNING *
    `;

    console.log(`[RATE] Avaliação salva. Atualizando média do personal...`);

    // 3. Atualizar o ranking do personal no perfil dele (Opcional, não deve travar o envio)
    try {
      const [avgData] = await sql`
        SELECT AVG(nota_profissional) as avg_rating, COUNT(*) as total_ratings
        FROM avaliacoes_treinos
        WHERE id_destino = ${finalTrainerId.toString()}
      `;

      if (avgData && avgData.avg_rating) {
        await sql`
          UPDATE personal_profiles 
          SET rating = ${parseFloat(avgData.avg_rating).toFixed(1)}, 
              total_avaliacoes = ${parseInt(avgData.total_ratings, 10)}
          WHERE id_trainer = ${parseInt(finalTrainerId, 10)}
        `;
        console.log(`[RATE] Ranking do personal ${finalTrainerId} atualizado.`);
      }
    } catch (profileErr) {
      console.error("[RATE] Aviso: Erro ao atualizar perfil do personal, mas avaliação foi salva:", profileErr.message);
    }

    return res.status(201).json({ message: "Avaliação enviada com sucesso!", data: rating });
  } catch (err) {
    console.error("[RATE] Erro Detalhado:", err);
    res.status(500).json({
      error: "Erro interno ao salvar avaliação.",
      message: err.message,
      code: err.code
    });
  }
});

app.post("/api/appointments", verifyToken, async (req, res) => {
  const userId = req.userId;
  const { trainerId, date, startTime, endTime, notes } = req.body;

  try {
    console.log(`[POST Appointments] User ${userId} -> Trainer ${trainerId}, Data ${date}, ${startTime}-${endTime}`);

    // Extrair dia da semana usando UTC para consistência total
    const [year, month, day] = date.split('-').map(Number);
    const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

    // Buscar disponibilidade para o dia calculado
    const availability = await sql`
      SELECT * FROM disponibilidade_trainer 
      WHERE id_trainer = ${parseInt(trainerId, 10)} 
        AND dia_semana = ${dayOfWeek} 
        AND ativo = TRUE
    `;

    console.log(`[POST Appointments] Dia Semana: ${dayOfWeek}, Registros encontrados: ${availability.length}`);

    if (availability.length === 0) {
      console.log(`[POST Appointments] Erro: Trainer não atende no dia ${dayOfWeek}`);
      return res.status(409).json({
        error: "Trainer não atende neste dia da semana",
        details: { dayOfWeek, date }
      });
    }

    // Validar se o horário solicitado está dentro da janela de disponibilidade
    const hasSlot = availability.some(slot => {
      const dbStart = (slot.hora_inicio || "").substring(0, 5);
      const dbEnd = (slot.hora_fim || "").substring(0, 5);
      const reqStart = (startTime || "").substring(0, 5);
      const reqEnd = (endTime || "").substring(0, 5);

      const isWithin = reqStart >= dbStart && reqEnd <= dbEnd;
      if (isWithin) console.log(`[POST Appointments] Horário validado: ${reqStart}-${reqEnd} dentro de ${dbStart}-${dbEnd}`);
      return isWithin;
    });

    if (!hasSlot) {
      console.log(`[POST Appointments] Erro: Horário ${startTime}-${endTime} fora da disponibilidade`);
      return res.status(409).json({
        error: "Trainer não tem disponibilidade neste dia/horário",
        details: { requested: `${startTime}-${endTime}`, dayOfWeek }
      });
    }

    // Verificar Conflitos com outros agendamentos
    const conflicts = await sql`
      SELECT id_agendamento FROM agendamentos 
      WHERE id_trainer = ${parseInt(trainerId, 10)}
        AND data_agendamento = ${date}
        AND status IN ('pendente', 'confirmado')
        AND (hora_inicio < ${endTime} AND hora_fim > ${startTime})
    `;

    if (conflicts.length > 0) {
      console.log(`[POST Appointments] Erro: Conflito detectado`);
      return res.status(409).json({ error: "Horário já reservado por outro aluno" });
    }

    const [appt] = await sql`
      INSERT INTO agendamentos (
        id_trainer, id_usuario, data_agendamento, hora_inicio, hora_fim, status, notas
      ) VALUES (
        ${parseInt(trainerId, 10)}, ${userId}, ${date}, ${startTime}, ${endTime}, 'pendente', ${notes}
      ) RETURNING *
    `;

    console.log(`[POST Appointments] Agendamento criado: ID ${appt.id_agendamento}`);
    return res.status(201).json({ success: true, appointment: appt });

  } catch (err) {
    console.error("[POST Appointments] Erro crítico:", err);
    return res.status(500).json({ error: "Erro interno ao processar agendamento." });
  }
});

// ==================== ROTAS DE ACADEMIAS (GYMS) ==================== //

const gymDetailsRoutes = require('./routes/gymDetails');
app.use('/api/academias', gymDetailsRoutes);

app.get("/api/academias/nearby", async (req, res) => {
  try {
    const gyms = await sql`SELECT * FROM academias WHERE ativo = TRUE LIMIT 10`;
    return res.status(200).json(gyms);
  } catch (e) {
    return res.status(500).json({ error: "Erro ao buscar academias." });
  }
});

// -------------------------------- INICIALIZAÇÃO ---------------------------- //

// -------------------------------- INICIALIZAÇÃO ---------------------------- //

console.log("🛠️ Tentando iniciar servidor na porta 3000...");

app.listen(3000, "0.0.0.0", () => {
  console.log("------------------------------------------");
  console.log("🚀 BACKEND MOVT RODANDO COM SUCESSO!");
  console.log("📍 Base URL: http://localhost:3000");
  console.log("------------------------------------------");
}).on('error', (err) => {
  console.error("❌ Erro ao iniciar servidor:", err);
});

module.exports = app;

