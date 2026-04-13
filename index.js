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
const { GoogleGenerativeAI } = require("@google/generative-ai");
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
  idle_timeout: 60, // Aumentado para manter conexões por mais tempo
  connect_timeout: 30, // Aumentado para 30s para evitar timeouts de rede
  max_lifetime: 60 * 30, // 30 minutos de vida máxima por conexão
  keepalive: true, // Crucial para evitar ECONNRESET e timeouts
  prepare: false,
  onnotice: () => { },
  onclose: () => {
    // Silencioso por padrão
  }
});

// Inicialização do Banco - Garantir colunas necessárias
async function initDb() {
  try {
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS location TEXT DEFAULT 'São Paulo'`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS job_title TEXT DEFAULT 'Entusiasta Fitness'`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT NULL`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS updatedat TIMESTAMP DEFAULT CURRENT_TIMESTAMP`;
    
    // Novas colunas de avatar e banner (usadas em EditProfileScreen)
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS avatar_url TEXT DEFAULT NULL`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS avatar_thumbnail TEXT DEFAULT NULL`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS avatar_medium TEXT DEFAULT NULL`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS avatar_large TEXT DEFAULT NULL`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS banner_url TEXT DEFAULT NULL`;

    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS cref TEXT DEFAULT NULL`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS cnpj TEXT DEFAULT NULL`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS formacao TEXT DEFAULT NULL`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS verificado BOOLEAN DEFAULT FALSE`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS cnpj_verified BOOLEAN DEFAULT FALSE`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS cref_verified BOOLEAN DEFAULT FALSE`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS status_verificacao TEXT DEFAULT 'pendente'`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS document_url TEXT DEFAULT NULL`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ativo BOOLEAN DEFAULT TRUE`;

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
    await sql`ALTER TABLE posts ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT FALSE`;

    // Garantir tabela de follows e migrar se necessário
    await sql`CREATE TABLE IF NOT EXISTS follows (
      id SERIAL PRIMARY KEY,
      follower_user_id INTEGER REFERENCES usuarios(id_us) ON DELETE CASCADE,
      followed_user_id INTEGER REFERENCES usuarios(id_us) ON DELETE CASCADE,
      status TEXT DEFAULT 'accepted', -- 'pending', 'accepted', 'rejected'
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(follower_user_id, followed_user_id)
    )`;
    await sql`ALTER TABLE follows ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'accepted'`;

    // Garantir tabela de notificações
    await sql`CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES usuarios(id_us) ON DELETE CASCADE,
      type TEXT NOT NULL, -- 'like', 'follow', 'follow_request', 'comment'
      sender_id INTEGER REFERENCES usuarios(id_us) ON DELETE CASCADE,
      reference_id INTEGER, -- id do post, etc
      message TEXT,
      read BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`;
    
    // Ativar realtime para a tabela no Supabase
    try {
      await sql`ALTER PUBLICATION supabase_realtime ADD TABLE notifications;`;
    } catch (e) {
      // Ignorar se já estiver adicionada
    }

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
    } catch (_migrateErr) {
      console.log("Aviso: Falha ao renomear coluna ou coluna ja renomeada.");
    }

    await sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS last_sender_id TEXT DEFAULT NULL`;
    await sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS deleted_at_p1 TIMESTAMP WITH TIME ZONE DEFAULT NULL`;
    await sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS deleted_at_p2 TIMESTAMP WITH TIME ZONE DEFAULT NULL`;

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

    // ====== PLANOS DE ASSINATURA ======
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'free'`;
    // Garantir que a constraint inclua 'familia' (remove a antiga se existir e recria)
    await sql`
      DO $$
      BEGIN
        -- Remover constraint antiga se existir (sem 'familia')
        IF EXISTS (
          SELECT 1 FROM information_schema.constraint_column_usage
          WHERE table_name = 'usuarios' AND column_name = 'plan'
        ) THEN
          ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_plan_check;
        END IF;
        -- Adicionar constraint atualizada com os 3 planos
        ALTER TABLE usuarios ADD CONSTRAINT usuarios_plan_check
          CHECK (plan IN ('free', 'premium', 'familia'));
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMP DEFAULT NULL`;
    // Contador mensal de comunidades ingressadas (reiniciado todo mês pelo backend ao checar)
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS community_joins_month INTEGER DEFAULT 0`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS community_joins_month_reset TIMESTAMP DEFAULT NOW()`;

    // Tabela de membros de comunidades (tracking real de adesões)
    await sql`CREATE TABLE IF NOT EXISTS community_members (
      id SERIAL PRIMARY KEY,
      id_comunidade INTEGER NOT NULL,
      id_us INTEGER NOT NULL REFERENCES usuarios(id_us) ON DELETE CASCADE,
      joined_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(id_comunidade, id_us)
    )`;

    // Garantir constraint de comunidade
    try {
      await sql`ALTER TABLE community_members ADD CONSTRAINT community_members_id_comunidade_fkey FOREIGN KEY (id_comunidade) REFERENCES comunidades(id) ON DELETE CASCADE`;
    } catch (_e) {
      // Ignorar erro se a constraint já existir
    }

    // Garantir colunas extras na tabela academias
    await sql`ALTER TABLE academias ADD COLUMN IF NOT EXISTS website TEXT DEFAULT NULL`;
    await sql`ALTER TABLE academias ADD COLUMN IF NOT EXISTS horarios_funcionamento JSONB DEFAULT NULL`;
    await sql`ALTER TABLE academias ADD COLUMN IF NOT EXISTS fotos TEXT[] DEFAULT '{}'`;
    await sql`ALTER TABLE academias ADD COLUMN IF NOT EXISTS email TEXT DEFAULT NULL`;

    // Tabela para comprovantes de pagamento (recebimentos do personal)
    await sql`CREATE TABLE IF NOT EXISTS comprovantes_pagamentos (
      id SERIAL PRIMARY KEY,
      id_agendamento INTEGER UNIQUE NOT NULL,
      id_trainer INTEGER NOT NULL,
      id_usuario INTEGER NOT NULL,
      valor_lido DECIMAL(10,2) DEFAULT 0.00,
      arquivo_url TEXT,
      metadata_ia JSONB,
      status TEXT DEFAULT 'pendente',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`;

    // Garantir que a tabela de agendamentos tenha status pendente de pagamento
    // Coluna para marcar se o agendamento já teve check-in de pagamento
    await sql`ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS pagamento_verificado BOOLEAN DEFAULT FALSE`;
    await sql`ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS valor_recebido DECIMAL(10,2) DEFAULT 0.00`;

    // Garantir colunas de curtidas e comentários na tabela de dietas
    await sql`ALTER TABLE dietas ADD COLUMN IF NOT EXISTS likes_count INTEGER DEFAULT 0`;
    await sql`ALTER TABLE dietas ADD COLUMN IF NOT EXISTS comments_count INTEGER DEFAULT 0`;
    await sql`ALTER TABLE dietas ADD COLUMN IF NOT EXISTS likes JSONB DEFAULT '[]'`;
    await sql`ALTER TABLE dietas ADD COLUMN IF NOT EXISTS comments JSONB DEFAULT '[]'`;

    console.log("✅ Banco de dados sincronizado.");
  } catch (err) {
    console.error("❌ Erro ao sincronizar banco de dados:", err);
  }
}
initDb();

// Configuração Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENERATIVE_AI_KEY);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

async function analyzeCrefDocument(fileBuffer, mimeType) {
  try {
    const base64Image = fileBuffer.toString("base64");
    
    const prompt = `Analise este documento de identidade profissional (CREF). 
    Retorne APENAS um JSON válido no seguinte formato:
    {
      "is_valid_document": boolean,
      "cref_number": "string ou null",
      "full_name": "string ou null",
      "uf": "string ou null",
      "confidence_score": number (0 a 100)
    }
    Considere 'is_valid_document' como verdadeiro se for uma carteira do CONFEF/CREF legível.`;

    const result = await geminiModel.generateContent([
      {
        inlineData: {
          data: base64Image,
          mimeType: mimeType
        }
      },
      { text: prompt }
    ]);

    const responseText = result.response.text();
    // Extrair JSON da resposta caso a IA coloque blocos de código markdown
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    return JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
  } catch (error) {
    console.error("Erro na análise do Gemini:", error);
    return null;
  }
}

async function analyzeReceiptDocument(fileBuffer, mimeType) {
  try {
    const base64Image = fileBuffer.toString("base64");
    
    const prompt = `Analise este comprovante de pagamento (PIX, Transferência, Depósito, etc). 
    Extraia o VALOR total pago e o NOME do pagador.
    Retorne APENAS um JSON válido no seguinte formato:
    {
      "is_valid_receipt": boolean,
      "amount": number,
      "payer_name": "string ou null",
      "date": "string ou null",
      "confidence_score": number
    }
    Considere 'is_valid_receipt' como verdadeiro se for um comprovante de transação bancária legível.`;

    const result = await geminiModel.generateContent([
      {
        inlineData: {
          data: base64Image,
          mimeType: mimeType
        }
      },
      { text: prompt }
    ]);

    const responseText = result.response.text();
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    return JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
  } catch (error) {
    console.error("Erro na análise do Gemini (Receipt):", error);
    return null;
  }
}


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

// Função auxiliar para resolver ID de usuário (pode ser INTEGER ou UUID)
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

// Função auxiliar para obter o UUID do Supabase Auth a partir do ID do seu banco
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

// Função para garantir que o usuário existe no Supabase Auth e retornar seu UUID
async function ensureUserInSupabaseAuth(user) {
  const { data: existingUser, error: searchError } = await supabase
    .from('user_id_mapping')
    .select('auth_user_id')
    .eq('id_us', user.id_us)
    .single();

  if (!searchError && existingUser) {
    // usuário já está mapeado
    return existingUser;
  }

  // Tenta encontrar o usuário no Supabase Auth pelo email
  const { data: supabaseUsers, error: authError } = await supabase
    .from('auth.users')
    .select('id')
    .eq('email', user.email)
    .limit(1);

  if (!authError && supabaseUsers && supabaseUsers.length > 0) {
    // usuário encontrado no Supabase Auth, criar mapeamento
    const authUserId = supabaseUsers[0].id;

    const { error: insertError } = await supabase
      .from('user_id_mapping')
      .insert({
        id_us: user.id_us,
        auth_user_id: authUserId
      });

    if (insertError) {
      console.error("Erro ao inserir mapeamento de usuário:", insertError);
    } else {
      console.log(`Mapeamento criado para usuário ${user.id_us} -> ${authUserId}`);
    }

    return { auth_user_id: authUserId };
  }

  // Se o usuário não existe no Supabase Auth, precisamos criá-lo
  // Vamos usar o Admin API do Supabase para criar o usuário
  console.log(`Usuário com email ${user.email} não encontrado no Supabase Auth. Criando usuário...`);

  try {
    // Criar o usuário no Supabase Auth usando o Admin API
    const { data: userData, error: createUserError } = await supabase.auth.admin.createUser({
      email: user.email,
      email_confirm: true, // Confirmar o email automaticamente
      password: null, // Não definir senha, pois o usuário já existe no seu sistema
    });

    if (createUserError) {
      console.error("Erro ao criar usuário no Supabase Auth:", createUserError);
      // Se não conseguir criar via Admin API, vamos gerar um UUID temporário
      const generatedUuid = generateUuidForUser(user.id_us, user.email);

      const { error: insertError } = await supabase
        .from('user_id_mapping')
        .insert({
          id_us: user.id_us,
          auth_user_id: generatedUuid
        });

      if (insertError) {
        console.error("Erro ao inserir mapeamento de usuário:", insertError);
        return null;
      }

      console.log(`Mapeamento temporário criado para usuário ${user.id_us} -> ${generatedUuid}`);
      return { auth_user_id: generatedUuid };
    }

    // Usuário criado com sucesso, criar o mapeamento
    const { error: insertError } = await supabase
      .from('user_id_mapping')
      .insert({
        id_us: user.id_us,
        auth_user_id: userData.user.id
      });

    if (insertError) {
      console.error("Erro ao inserir mapeamento de usuário:", insertError);
      return null;
    }

    console.log(`Usuário criado e mapeamento realizado para ${user.id_us} -> ${userData.user.id}`);
    return { auth_user_id: userData.user.id };
  } catch (adminError) {
    console.error("Erro ao usar Admin API para criar usuário:", adminError);
    // Em caso de erro, gerar UUID temporário como fallback
    const generatedUuid = generateUuidForUser(user.id_us, user.email);

    const { error: insertError } = await supabase
      .from('user_id_mapping')
      .insert({
        id_us: user.id_us,
        auth_user_id: generatedUuid
      });

    if (insertError) {
      console.error("Erro ao inserir mapeamento de usuário:", insertError);
      return null;
    }

    console.log(`Mapeamento temporário criado para usuário ${user.id_us} -> ${generatedUuid}`);
    return { auth_user_id: generatedUuid };
  }
}

// Função auxiliar para gerar UUID baseado no ID do usuário e email
function generateUuidForUser(userId, email) {
  // Esta é uma implementação simplificada
  // Em produção, você deve usar uma biblioteca adequada para gerar UUIDs
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
    subject: "Verificação de E-mail para MOVT App",
    html: `
      <p>Olá,</p>
      <p>Obrigado por se registrar no MOVT App!</p>
      <p>Seu código de verificação é:</p>
      <h3>${verificationCode}</h3>
      <p>Este código expira em 15 minutos.</p>
      <p>Se você não solicitou esta verificação, por favor, ignore este e-mail.</p>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`E-mail de verificação enviado para ${toEmail}`);
    return true;
  } catch (error) {
    console.error(
      `Erro ao enviar e-mail de verificação para ${toEmail}:`,
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

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));
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

// ==================== MIDDLEWARE DE PLANO ==================== //

/**
 * Middleware: verifica se o usuário free ainda tem quota para a feature.
 * feature: 'agendamentos' | 'comunidades' | 'dietas'
 */
function checkFreePlanLimit(feature) {
  return async function (req, res, next) {
    const userId = req.userId;
    if (!userId) return next();

    try {
      const [user] = await sql`
        SELECT plan, plan_expires_at, community_joins_month, community_joins_month_reset
        FROM usuarios WHERE id_us = ${userId}
      `;

      if (!user) return next();

      // Premium sem expiração OU premium ainda válido → acesso total
      const isPremium = user.plan === 'premium' &&
        (!user.plan_expires_at || new Date(user.plan_expires_at) > new Date());

      if (isPremium) return next();

      // ---- Usuário FREE: aplicar restrições ----

      // dietas: sem restrição de plano — todos os usuários podem criar dietas

      if (feature === 'agendamentos') {
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const [{ count }] = await sql`
          SELECT COUNT(*) as count FROM agendamentos
          WHERE id_usuario = ${userId}
            AND created_at >= ${startOfMonth}
        `;
        const used = parseInt(count, 10);
        if (used >= 50) {
          return res.status(403).json({
            error: 'FREE_LIMIT_REACHED',
            message: 'Você atingiu o limite de 50 agendamentos por mês no plano gratuito.',
            feature: 'agendamentos',
            used,
            limit: 50
          });
        }
        return next();
      }

      if (feature === 'comunidades') {
        const now = new Date();
        // Reinicia contador se mudou o mês
        if (user.community_joins_month_reset) {
          const resetDate = new Date(user.community_joins_month_reset);
          if (resetDate.getMonth() !== now.getMonth() || resetDate.getFullYear() !== now.getFullYear()) {
            await sql`UPDATE usuarios SET community_joins_month = 0, community_joins_month_reset = NOW() WHERE id_us = ${userId}`;
            user.community_joins_month = 0;
          }
        }
        if (user.community_joins_month >= 50) {
          return res.status(403).json({
            error: 'FREE_LIMIT_REACHED',
            message: 'Você atingiu o limite de 50 comunidades por mês no plano gratuito.',
            feature: 'comunidades',
            used: user.community_joins_month,
            limit: 50
          });
        }
        return next();
      }

      return next();
    } catch (err) {
      console.error('[checkFreePlanLimit] Erro:', err);
      return next(); // em caso de erro, não bloqueia
    }
  };
}

// ==================== ROTA: Status do plano ==================== //
// Exposta apenas internamente via verifyToken

// Middleware de verificação de sessão
function verifyToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res
      .status(403)
      .json({ message: "Token de sessão não fornecido ou formato inválido." });
  }

  const sessionId = authHeader.split(" ")[1];

  // Testar conexão com o banco de dados antes de tentar a consulta
  sql`SELECT 1`
    .then(() => {
      return sql`SELECT id_us FROM usuarios WHERE session_id = ${sessionId}`;
    })
    .then((users) => {
      if (users.length === 0) {
        return res.status(401).json({ message: "Sessão inválida ou expirada." });
      }

      const user = users[0];
      return sql`SELECT ativo FROM usuarios WHERE id_us = ${user.id_us}`.then(([status]) => {
        if (status && status.ativo === false) {
          return res.status(403).json({ error: "USER_INACTIVE", message: "Sua conta está inativa." });
        }
        req.userId = user.id_us;
        next();
      });
    })
    .catch((error) => {
      console.error("Erro na verificação do token de sessão:", error);

      // Verificar se é um erro de conexão com o banco de dados
      if (error.message && (error.message.includes('Tenant or user not found') || error.message.includes('FATAL'))) {
        return res.status(503).json({
          error: "Erro de conexão com o banco de dados. Serviço temporariamente indisponível.",
          details: "O sistema de autenticação está temporariamente indisponível. Tente novamente mais tarde."
        });
      }

      res.status(500).json({
        error: "Erro interno do servidor na verificação do token.",
        details: error.message,
      });
    });
}

// ==================== CONFIGURAÇÃO DE UPLOAD ==================== //

const storage = multer.memoryStorage();

// Middleware para upload de imagens de perfil
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

// Middleware para upload de documentos (CREF)
const documentUpload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB para documentos
  fileFilter: (req, file, cb) => {
    const validTypes = ["image/jpeg", "image/png", "application/pdf"];
    if (!validTypes.includes(file.mimetype)) {
      return cb(new Error("Formato de arquivo não suportado. Use JPG, PNG ou PDF."));
    }
    cb(null, true);
  },
});

// ==================== ROTAS DE VALIDAÇÃO PROFISSIONAL ==================== //

// Rota para validar CNPJ via BrasilAPI
app.get("/api/verify/cnpj/:cnpj", async (req, res) => {
  const cnpj = req.params.cnpj.replace(/[^0-9]/g, "");

  if (cnpj.length !== 14) {
    return res.status(400).json({ error: "CNPJ inválido. Deve conter 14 dígitos." });
  }

  try {
    const axios = require('axios');
    const response = await axios.get(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`);
    
    const data = response.data;
    
    // Verifica se a empresa está ativa e se o CNAE é compatível (exemplo simples)
    const isActive = data.descricao_situacao_cadastral === "ATIVA";
    
    res.json({
      success: true,
      data: {
        razao_social: data.razao_social,
        nome_fantasia: data.nome_fantasia,
        situacao: data.descricao_situacao_cadastral,
        cnae: data.cnae_fiscal,
        cnae_descricao: data.cnae_fiscal_descricao,
        isActive
      }
    });
  } catch (error) {
    console.error("Erro ao validar CNPJ:", error.response?.data || error.message);
    const status = error.response?.status || 500;
    const msg = error.response?.data?.message || "Erro ao consultar CNPJ na base da Receita Federal.";
    res.status(status).json({ error: msg });
  }
});

// Rota para salvar dados profissionais (CNPJ e CREF)
app.put("/api/user/professional-data", verifyToken, async (req, res) => {
  const { cnpj, cref, formacao } = req.body;
  const userId = req.userId;

  try {
    await sql`
      UPDATE usuarios 
      SET 
        cnpj = ${cnpj || null},
        cref = ${cref || null},
        formacao = ${formacao || null},
        updated_at = CURRENT_TIMESTAMP
      WHERE id_us = ${userId}
    `;

    res.json({ success: true, message: "Dados profissionais atualizados com sucesso." });
  } catch (error) {
    console.error("Erro ao atualizar dados profissionais:", error);
    res.status(500).json({ error: "Erro ao salvar dados profissionais." });
  }
});

app.put("/api/user/document", verifyToken, documentUpload.single("document"), async (req, res) => {
  const userId = req.userId;
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: "Nenhum arquivo enviado." });
  }

  try {
    // 1. Validar com IA antes de fazer o upload
    console.log(`[KYC] Iniciando análise de IA para usuário ${userId}...`);
    const aiAnalysis = await analyzeCrefDocument(file.buffer, file.mimetype);
    
    // Buscar dados atuais do usuário para cruzar
    const [user] = await sql`SELECT nome, cref FROM usuarios WHERE id_us = ${userId}`;
    
    let aiStatus = 'pendente';
    let aiVerified = false;
    let observation = "";

    if (aiAnalysis && aiAnalysis.is_valid_document) {
      // Cruzamento de dados: Verificar se o número do CREF na foto bate com o do banco
      const dbCrefClean = (user.cref || "").replace(/[^0-9]/g, "");
      const aiCrefClean = (aiAnalysis.cref_number || "").replace(/[^0-9]/g, "");
      
      const crefMatch = aiCrefClean.includes(dbCrefClean) || dbCrefClean.includes(aiCrefClean);
      
      if (crefMatch && aiAnalysis.confidence_score > 80) {
        aiStatus = 'aprovado';
        aiVerified = true;
        console.log(`[KYC] ✅ Auto-aprovação via IA para usuário ${userId}`);
      } else {
        observation = `IA detectou divergência: CREF na foto (${aiAnalysis.cref_number}) vs Digitado (${user.cref})`;
        console.log(`[KYC] ⚠️ Divergência detectada para usuário ${userId}`);
      }
    } else {
      observation = "IA não conseguiu validar a autenticidade do documento.";
    }

    // 2. Prosseguir com Upload para o Supabase
    const uuid = uuidv4();
    const ext = file.mimetype.split("/")[1];
    const path = `documents/${userId}/${uuid}.${ext}`;

    const { data: uploadData, error: uploadError } = await supabase.storage
      .from(AVATAR_BUCKET)
      .upload(path, file.buffer, {
        contentType: file.mimetype,
        upsert: true,
      });

    if (uploadError) throw uploadError;

    const { data: publicUrlData } = supabase.storage
      .from(AVATAR_BUCKET)
      .getPublicUrl(path);

    await sql`
      UPDATE usuarios 
      SET 
        document_url = ${publicUrlData.publicUrl},
        status_verificacao = ${aiStatus},
        cref_verified = ${aiVerified},
        updated_at = CURRENT_TIMESTAMP
      WHERE id_us = ${userId}
    `;

    res.json({ 
      success: true, 
      message: aiVerified ? "Documento validado e aprovado instantaneamente!" : "Documento enviado para análise manual.",
      url: publicUrlData.publicUrl,
      ai_analysis: {
        status: aiStatus,
        observation: observation
      }
    });
  } catch (error) {
    console.error("Erro no upload de documento:", error);
    res.status(500).json({ error: "Erro ao processar upload do documento." });
  }
});

// Função principal para processar um upload de avatar usando Supabase Storage
async function processAndSaveAvatar(userId, fileBuffer, mimetype) {
  // Verifica se Supabase está configurado
  if (!supabase) {
    throw { code: 500, message: "Supabase Storage não configurado. Verifique as variáveis de ambiente." };
  }

  // Validação extra: tipos válidos
  const validMimeTypes = ["image/jpeg", "image/png", "image/webp"];
  if (!validMimeTypes.includes(mimetype)) {
    throw { code: 422, message: "Formato de imagem não suportado." };
  }

  // Checa dimensões máximas (2k x 2k)
  let image;
  try {
    image = sharp(fileBuffer);
    const metadata = await image.metadata();
    if (
      metadata.width > 2000 ||
      metadata.height > 2000
    ) {
      throw { code: 422, message: "A imagem deve ter no máximo 2000x2000 px." };
    }
  } catch (err) {
    if (err.code) throw err;
    throw { code: 400, message: "Arquivo de imagem inválido." };
  }

  // Paths/nomes no Supabase Storage
  const uuid = uuidv4();
  const base = `avatar_${userId}_${uuid}`;
  const ext = mimetype === "image/png" ? "png" : mimetype === "image/webp" ? "webp" : "jpg";

  // Processa as versões redimensionadas
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

  // Faz upload de todas as versões para o Supabase Storage
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

  // Obtém URLs públicas dos arquivos
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

// Função auxiliar para gerar dados mockados 
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

// ------------------- AUTENTICAÇÃO DE USUÁRIO --------------------- //

app.post("/api/login", async (req, res) => {

  const { email, senha, sessionId: providedSessionId } = req.body;

  if (!email || !senha) {
    return res.status(400).json({ error: "Email e senha são obrigatórios." });
  }

  try {
    // Testar conexão com o banco de dados antes de tentar a consulta
    try {
      await sql`SELECT 1`;
    } catch (dbError) {
      console.error("Erro na conexão com o banco de dados:", dbError);
      return res.status(503).json({
        error: "Serviço de banco de dados temporariamente indisponível.",
        details: dbError.message
      });
    }

    const [user] = await sql`
      SELECT id_us, email, senha, username, nome, session_id, email_verified, role, ativo
      FROM usuarios
      WHERE email = ${email};
    `;

    if (!user) {
      return res
        .status(401)
        .json({ error: "Endereço de e-mail incorreto, tente novamente!" });
    }

    if (user.ativo === false) {
      return res.status(403).json({ 
        error: "Conta inativa", 
        message: "Sua conta foi desativada pelo administrador. Entre em contato com o suporte." 
      });
    }

    const isPasswordValid = await bcrypt.compare(senha, user.senha);

    if (!isPasswordValid) {
      return res
        .status(401)
        .json({ error: "Senha inválida, tente novamente!" });
    }

    if (providedSessionId && providedSessionId !== user.session_id) {
      return res
        .status(401)
        .json({ error: "Token de sessão inconsistente ou inválido." });
    }

    console.log(`[LOGIN] Buscando mapeamento Supabase para usuário ID ${user.id_us}...`);
    // Obter o UUID do Supabase Auth para o usuário
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
        role: user.role,
      },
      sessionId: user.session_id,
    });
  } catch (error) {
    console.error("Erro ao autenticar usuário:", error);

    // Verificar se é um erro de conexão com o banco de dados
    if (error.message && (error.message.includes('Tenant or user not found') || error.message.includes('FATAL'))) {
      return res.status(503).json({
        error: "Erro de conexão com o banco de dados. Serviço temporariamente indisponível.",
        details: "O sistema de autenticação está temporariamente indisponível. Tente novamente mais tarde."
      });
    }

    res.status(500).json({
      error: "Erro interno do servidor ao autenticar usuário.",
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
    return res.status(400).json({ error: "Todos os campos são obrigatórios." });
  }

  try {
    // Testar conexão com o banco de dados antes de tentar a consulta
    try {
      await sql`SELECT 1`;
    } catch (dbError) {
      console.error("Erro na conexão com o banco de dados:", dbError);
      return res.status(503).json({
        error: "´Serviço de banco de dados temporariamente indisponível.",
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
          .json({ error: "Este e-mail já está cadastrado." });
      } else if (existingUser[0].cpf === userCpf && userCpf !== null) {
        return res.status(409).json({ error: "Este CPF já está cadastrado." });
      } else if (existingUser[0].cnpj === userCnpj && userCnpj !== null) {
        return res.status(409).json({ error: "Este CNPJ já está cadastrado." });
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
        "Falha ao enviar e-mail de verificação para o novo usuário.",
      );
    }

    console.log(`✅ Registro realizado: ${email}`);
    res.status(201).json({
      message: "Usuário registrado com sucesso! Verifique seu e-mail.",
      user: newUser,
      sessionId: newSessionId,
    });
  } catch (error) {
    console.error("Erro ao registrar usuário:", error);

    // Verificar se é um erro de conexão com o banco de dados
    if (error.message && (error.message.includes('Tenant or user not found') || error.message.includes('FATAL'))) {
      return res.status(503).json({
        error: "Erro de conexão com o banco de dados. Serviço temporariamente indisponível.",
        details: "O sistema de registro está temporariamente indisponível. Tente novamente mais tarde."
      });
    }

    if (error.code === "23505") {
      return res.status(409).json({
        error:
          "Erro de unicidade no banco de dados (e.g., email, CPF ou CNPJ).",
      });
    }
    res.status(500).json({
      error: "Erro interno do servidor ao registrar usuário.",
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

// PATCH: Editar plano na Stripe (Admin)
app.patch("/api/admin/plans/:id", verifyToken, upload.single('image'), async (req, res) => {
  const _requesterId = req.userId;
  const [_requesterRole] = await sql`SELECT role FROM usuarios WHERE id_us = ${_requesterId}`;
  const { id } = req.params; // ID do Produto na Stripe
  const { name, description, price, active } = req.body;

  try {
    if (!_requesterRole || (_requesterRole.role || "").trim().toLowerCase() !== 'admin') {
      return res.status(403).json({ error: "Acesso negado." });
    }

    let updateParams = {};
    if (name) updateParams.name = name;
    if (description) updateParams.description = description;
    if (active !== undefined) updateParams.active = active === 'true' || active === true;

    // Se houver nova imagem, faz o upload para o Supabase
    if (req.file) {
      const fileName = `plans/${uuidv4()}-${req.file.originalname}`;
      const { data, error } = await supabase.storage
        .from(AVATAR_BUCKET)
        .upload(fileName, req.file.buffer, { contentType: req.file.mimetype });
      
      if (!error) {
        const { data: publicUrlData } = supabase.storage
          .from(AVATAR_BUCKET)
          .getPublicUrl(fileName);
        updateParams.images = [publicUrlData.publicUrl];
      }
    }

    // Atualiza o produto na Stripe
    await stripe.products.update(id, updateParams);

    // Lógica para atualização de preço
    if (price) {
      const newAmount = Math.round(parseFloat(price) * 100);
      const currentProduct = await stripe.products.retrieve(id, { expand: ['default_price'] });
      const currentPrice = currentProduct.default_price;

      if (!currentPrice || currentPrice.unit_amount !== newAmount) {
        const priceParams = {
          unit_amount: newAmount,
          currency: 'brl',
          product: id,
        };
        
        // Mantém a recorrência se o plano for assinatura
        if (currentPrice && currentPrice.recurring) {
          priceParams.recurring = { interval: currentPrice.recurring.interval };
        } else {
          // Fallback se não tiver preço padrão ou for fixo (opcional)
          // Aqui podemos decidir se padrão é mensal caso não exista
        }

        const newPrice = await stripe.prices.create(priceParams);
        
        // Define o novo preço como padrão para o produto
        await stripe.products.update(id, { default_price: newPrice.id });
      }
    }

    res.json({ success: true, message: "Plano atualizado com sucesso!" });
  } catch (error) {
    console.error("Erro ao atualizar plano na Stripe:", error);
    res.status(500).json({ error: "Erro ao atualizar plano na Stripe.", details: error.message });
  }
});

// DELETE: Arquivar plano na Stripe (Admin)
app.delete("/api/admin/plans/:id", verifyToken, async (req, res) => {
  const adminId = req.userId;
  const { id } = req.params;

  try {
    const [adminCheck] = await sql`SELECT role FROM usuarios WHERE id_us = ${adminId}`;
    if (!adminCheck || (adminCheck.role || "").trim().toLowerCase() !== 'admin') {
      return res.status(403).json({ error: "Acesso negado." });
    }

    // Na Stripe, não costumamos "deletar" um plano/produto, mas sim arquivá-lo
    // para não quebrar assinaturas antigas.
    await stripe.products.update(id, { active: false });

    res.json({ success: true, message: "Plano arquivado com sucesso!" });
  } catch (error) {
    console.error("Erro ao arquivar plano na Stripe:", error);
    res.status(500).json({ error: "Erro ao arquivar plano na Stripe.", details: error.message });
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

// --------------------- VERIFICAÇÃO DE USUá RIO --------------------- //

app.post("/api/user/send-verification", verifyToken, async (req, res) => {

  const userId = req.userId;

  try {
    const [user] =
      await sql`SELECT email, email_verified FROM usuarios WHERE id_us = ${userId}`;

    if (!user) {
      return res.status(404).json({ error: "Usuário não encontrado." });
    }
    if (user.email_verified) {
      return res
        .status(400)
        .json({ message: "Seu e-mail já está verificado." });
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
      console.log(`✅ Código de verificação enviado: ${user.email}`);
      res.status(200).json({
        message: "Novo código de verificação enviado para seu e-mail.",
      });
    } else {
      res
        .status(500)
        .json({ error: "Falha ao enviar o e-mail de verificação." });
    }
  } catch (error) {
    console.error("Erro ao reenviar código de verificação:", error);
    res.status(500).json({
      error: "Erro interno do servidor ao reenviar código.",
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
      .json({ error: "Código de verificação é obrigatório." });
  }

  try {
    const [user] = await sql`
      SELECT email_verified, verification_code, verification_code_expires_at
      FROM usuarios
      WHERE id_us = ${userId};
    `;

    if (!user) {
      return res.status(404).json({ error: "Usuário não encontrado." });
    }
    if (user.email_verified) {
      return res
        .status(400)
        .json({ message: "Seu e-mail já está verificado." });
    }
    if (!user.verification_code || user.verification_code !== code) {
      return res.status(400).json({ error: "Código de verificação inválido." });
    }
    if (
      user.verification_code_expires_at &&
      new Date() > user.verification_code_expires_at
    ) {
      return res
        .status(400)
        .json({ error: "Código de verificação expirado. Solicite um novo." });
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

// GET: Retorna dados do plano do usuário logado
app.get("/api/user/plan-status", verifyToken, async (req, res) => {
  const userId = req.userId;
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [user] = await sql`
      SELECT plan, plan_expires_at, community_joins_month, community_joins_month_reset
      FROM usuarios WHERE id_us = ${userId}
    `;

    if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });

    const isPremium = user.plan === 'premium' &&
      (!user.plan_expires_at || new Date(user.plan_expires_at) > now);

    // Agendamentos usados no mês
    const [{ count: apptCount }] = await sql`
      SELECT COUNT(*) as count FROM agendamentos
      WHERE id_usuario = ${userId} AND created_at >= ${startOfMonth}
    `;

    // Contador comunidades (resetar se precisar)
    let communityJoins = user.community_joins_month || 0;
    if (user.community_joins_month_reset) {
      const resetDate = new Date(user.community_joins_month_reset);
      if (resetDate.getMonth() !== now.getMonth() || resetDate.getFullYear() !== now.getFullYear()) {
        communityJoins = 0;
        await sql`UPDATE usuarios SET community_joins_month = 0, community_joins_month_reset = NOW() WHERE id_us = ${userId}`;
      }
    }

    return res.status(200).json({
      plan: isPremium ? 'premium' : 'free',
      plan_expires_at: user.plan_expires_at,
      limits: {
        agendamentos: { used: parseInt(apptCount, 10), limit: isPremium ? null : 2 },
        comunidades: { used: communityJoins, limit: isPremium ? null : 2 },
        dietas: { canCreate: isPremium }
      }
    });
  } catch (err) {
    console.error('[plan-status]', err);
    return res.status(500).json({ error: 'Erro ao buscar status do plano.' });
  }
});

// --------------------- ADMIN DASHBOARD STATS --------------------- //

app.get("/api/admin/dashboard-stats", verifyToken, async (req, res) => {
  const userId = req.userId;

  try {
    // 1. Verificar se é admin
    const [adminCheck] = await sql`SELECT role FROM usuarios WHERE id_us = ${userId}`;
    if (!adminCheck || (adminCheck.role || "").trim().toLowerCase() !== 'admin') {
      return res.status(403).json({ error: "Acesso negado. Apenas administradores podem acessar esta rota." });
    }

    const filterPlan = req.query.plan || 'all';
    const filterStatus = req.query.status || 'all';

    // 2. Coletar estatísticas do banco de dados (todas em uma query)
    // Se o filtro for 'all', mantemos a visão global. Se houver filtro, focamos no segmento.
    const [dbStats] = await sql`
      SELECT 
        COUNT(*) as total_users,
        COUNT(*) FILTER (WHERE role IN ('personal', 'trainer')) as total_trainers,
        COUNT(*) FILTER (WHERE role IN ('gym', 'academy')) as total_gyms,
        (SELECT COUNT(*) FROM academias WHERE ativo = TRUE) as total_gyms_real,
        COUNT(*) FILTER (WHERE plan = 'premium' AND (plan_expires_at IS NULL OR plan_expires_at > NOW())) as premium_count,
        COUNT(*) FILTER (WHERE plan = 'familia' AND (plan_expires_at IS NULL OR plan_expires_at > NOW())) as familia_count,
        COUNT(*) FILTER (WHERE plan = 'free' OR plan IS NULL) as free_count,
        -- Churn Calculation: Users who expired in the last 30 days and didn't renew
        COUNT(*) FILTER (WHERE plan_expires_at BETWEEN NOW() - INTERVAL '30 days' AND NOW()) as churned_30d,
        -- Prev Month Base for Percentage
        COUNT(*) FILTER (WHERE plan_expires_at BETWEEN NOW() - INTERVAL '60 days' AND NOW() - INTERVAL '31 days') as prev_month_base,
        -- Activity Stats
        (SELECT COUNT(*) FROM agendamentos) as total_appointments,
        (SELECT COUNT(*) FROM posts) as total_posts,
        (SELECT COUNT(*) FROM comunidades) as total_communities,
        (SELECT COUNT(*) FROM conteudo_treinos) as total_workouts,
        (SELECT COUNT(*) FROM usuarios WHERE role = 'admin') as total_admins
      FROM usuarios
    `;

    const totalUsers = parseInt(dbStats.total_users || '0');
    const premiumCount = parseInt(dbStats.premium_count || '0');
    const familiaCount = parseInt(dbStats.familia_count || '0');
    const freeCount = parseInt(dbStats.free_count || '0');
    const churned30d = parseInt(dbStats.churned_30d || '0');
    const prevMonthBase = Math.max(parseInt(dbStats.prev_month_base || '0'), 100); // Fallback to 100 to avoid high variance

    // 2.2 Financial Intelligence
    const paidCount = premiumCount + familiaCount;
    const conversionRate = totalUsers > 0 ? ((paidCount / totalUsers) * 100).toFixed(1) : '0.0';
    
    // Monthly Operational Cost (Hypothetical: $0.10 per active user + $500 base)
    const monthlyCost = (totalUsers * 0.10) + 500;
    
    // Churn Rate
    const churnRate = ((churned30d / prevMonthBase) * 100).toFixed(1);
    const churnNum = Math.min(parseFloat(churnRate), 100);
    const churnStatus = churnNum < 5 ? 'green' : churnNum < 15 ? 'yellow' : 'red';

    // LTV Estimation: (Average Revenue Per User) / Churn Rate
    // Assuming Avg Premium is $29.90
    const arpu = 29.90; 
    const ltv = churnNum > 0 ? (arpu / (churnNum / 100)) : (arpu * 24); // If churn 0, assume 24 months

    // 3. Coletar faturamento real do Stripe com suporte a período
    const period = (req.query.period || 'month'); // 'day' | 'month' | 'year'
    let revenueData = [];
    let grossRevenueCurrent = 0;
    let revenueGrowth = "+0%";

    const monthNames = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
    const now = new Date();

    // Definir janela de busca e rótulos conforme período
    let windowStart;
    if (period === 'day') {
      windowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    } else if (period === 'year') {
      windowStart = new Date(now.getFullYear(), 0, 1); // 1 Jan do ano atual
    } else {
      windowStart = new Date(now.getFullYear(), now.getMonth(), 1); // 1º do mês atual
    }

    if (stripe) {
      try {
        // Paginar pagamentos dentro da janela definida
        let allPayments = [];
        let hasMore = true;
        let lastId = undefined;
        while (hasMore) {
          const params = { limit: 100, created: { gte: Math.floor(windowStart.getTime() / 1000) } };
          if (lastId) params.starting_after = lastId;
          const batch = await stripe.paymentIntents.list(params);
          allPayments = allPayments.concat(batch.data.filter(p => p.status === 'succeeded'));
          hasMore = batch.has_more;
          lastId = batch.data.length > 0 ? batch.data[batch.data.length - 1].id : undefined;
          if (!lastId) hasMore = false;
        }

        // ------ HOJE: agrupa por hora (0h-23h) ------
        if (period === 'day') {
          for (let h = 0; h <= now.getHours(); h++) {
            const hourStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, 0, 0);
            const hourEnd   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h + 1, 0, 0);
            const hourTotal = allPayments
              .filter(p => p.created >= Math.floor(hourStart.getTime() / 1000) && p.created < Math.floor(hourEnd.getTime() / 1000))
              .reduce((acc, p) => acc + (p.amount / 100), 0);
            revenueData.push({ month: `${String(h).padStart(2, '0')}h`, total: parseFloat(hourTotal.toFixed(2)) });
          }
          grossRevenueCurrent = allPayments.reduce((acc, p) => acc + (p.amount / 100), 0);
          revenueGrowth = "+0%"; // comparação intraday não disponível

        // ------ MENSAL: agrupa por dia do mês atual ------
        } else if (period === 'month') {
          const daysInMonth = now.getDate();
          const firstDayOfCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
          const firstDayOfPrevMonth    = new Date(now.getFullYear(), now.getMonth() - 1, 1);

          for (let d = 1; d <= daysInMonth; d++) {
            const dayStart = new Date(now.getFullYear(), now.getMonth(), d);
            const dayEnd   = new Date(now.getFullYear(), now.getMonth(), d + 1);
            const dayTotal = allPayments
              .filter(p => p.created >= Math.floor(dayStart.getTime() / 1000) && p.created < Math.floor(dayEnd.getTime() / 1000))
              .reduce((acc, p) => acc + (p.amount / 100), 0);
            revenueData.push({ month: String(d), total: parseFloat(dayTotal.toFixed(2)) });
          }

          grossRevenueCurrent = allPayments.reduce((acc, p) => acc + (p.amount / 100), 0);

          // Buscar mês anterior para calcular crescimento
          let prevPayments = [];
          let hasMorePrev = true;
          let lastIdPrev = undefined;
          while (hasMorePrev) {
            const params = {
              limit: 100,
              created: {
                gte: Math.floor(firstDayOfPrevMonth.getTime() / 1000),
                lt: Math.floor(firstDayOfCurrentMonth.getTime() / 1000),
              },
            };
            if (lastIdPrev) params.starting_after = lastIdPrev;
            const batch = await stripe.paymentIntents.list(params);
            prevPayments = prevPayments.concat(batch.data.filter(p => p.status === 'succeeded'));
            hasMorePrev = batch.has_more;
            lastIdPrev = batch.data.length > 0 ? batch.data[batch.data.length - 1].id : undefined;
            if (!lastIdPrev) hasMorePrev = false;
          }
          const prevRevenue = prevPayments.reduce((acc, p) => acc + (p.amount / 100), 0);
          if (prevRevenue > 0) {
            const diff = ((grossRevenueCurrent - prevRevenue) / prevRevenue) * 100;
            revenueGrowth = `${diff >= 0 ? '+' : ''}${diff.toFixed(1)}%`;
          } else if (grossRevenueCurrent > 0) {
            revenueGrowth = "+100%";
          }

        // ------ ANUAL: agrupa por mês (Jan-Dez do ano atual) ------
        } else if (period === 'year') {
          const currentMonth = now.getMonth(); // 0-indexed
          for (let m = 0; m <= currentMonth; m++) {
            const mStart = new Date(now.getFullYear(), m, 1);
            const mEnd   = new Date(now.getFullYear(), m + 1, 1);
            const mTotal = allPayments
              .filter(p => p.created >= Math.floor(mStart.getTime() / 1000) && p.created < Math.floor(mEnd.getTime() / 1000))
              .reduce((acc, p) => acc + (p.amount / 100), 0);
            revenueData.push({ month: monthNames[m], total: parseFloat(mTotal.toFixed(2)) });
          }
          grossRevenueCurrent = allPayments.reduce((acc, p) => acc + (p.amount / 100), 0);

          // Comparar com o ano anterior
          const prevYearStart = new Date(now.getFullYear() - 1, 0, 1);
          const prevYearEnd   = new Date(now.getFullYear(), 0, 1);
          let prevYearPayments = [];
          let hasMorePY = true;
          let lastIdPY = undefined;
          while (hasMorePY) {
            const params = {
              limit: 100,
              created: { gte: Math.floor(prevYearStart.getTime() / 1000), lt: Math.floor(prevYearEnd.getTime() / 1000) },
            };
            if (lastIdPY) params.starting_after = lastIdPY;
            const batch = await stripe.paymentIntents.list(params);
            prevYearPayments = prevYearPayments.concat(batch.data.filter(p => p.status === 'succeeded'));
            hasMorePY = batch.has_more;
            lastIdPY = batch.data.length > 0 ? batch.data[batch.data.length - 1].id : undefined;
            if (!lastIdPY) hasMorePY = false;
          }
          const prevYearRevenue = prevYearPayments.reduce((acc, p) => acc + (p.amount / 100), 0);
          if (prevYearRevenue > 0) {
            const diff = ((grossRevenueCurrent - prevYearRevenue) / prevYearRevenue) * 100;
            revenueGrowth = `${diff >= 0 ? '+' : ''}${diff.toFixed(1)}%`;
          } else if (grossRevenueCurrent > 0) {
            revenueGrowth = "+100%";
          }
        }

      } catch (stripeErr) {
        console.error("Erro ao buscar dados do Stripe:", stripeErr);
        revenueData = [{ month: "-", total: 0 }];
      }
    } else {
      // Sem Stripe: placeholder vazio condizente com o período
      if (period === 'day') {
        for (let h = 0; h <= now.getHours(); h++) revenueData.push({ month: `${String(h).padStart(2,'0')}h`, total: 0 });
      } else if (period === 'month') {
        for (let d = 1; d <= now.getDate(); d++) revenueData.push({ month: String(d), total: 0 });
      } else {
        for (let m = 0; m <= now.getMonth(); m++) revenueData.push({ month: monthNames[m], total: 0 });
      }
    }

    // 4. Coletar todos os comprovantes com metadados (Admin View)
    let receiptHistory = [];
    try {
      receiptHistory = await sql`
        SELECT 
          cp.id_comprovante, cp.arquivo_url, cp.meta_data,
          a.valor_recebido, a.data_agendamento, a.hora_inicio,
          ut.nome as trainer_name, ut.avatar_url as trainer_avatar,
          uc.nome as client_name, uc.avatar_url as client_avatar
        FROM comprovantes_pagamentos cp
        JOIN agendamentos a ON cp.id_agendamento = a.id_agendamento
        JOIN usuarios ut ON a.id_trainer = ut.id_us
        JOIN usuarios uc ON a.id_usuario = uc.id_us
        ORDER BY a.data_agendamento DESC
        LIMIT 100
      `;
    } catch (err) {
      console.error("Erro ao buscar histórico de comprovantes (admin):", err.message);
    }

    // 4. Contagem de planos na Stripe
    let totalStripePlans = 0;
    if (stripe) {
      try {
        const products = await stripe.products.list({ active: true });
        totalStripePlans = products.data.length;
      } catch (e) {
        console.error("Erro ao contar planos Stripe para dashboard:", e);
      }
    }

    res.json({
      success: true,
      receiptHistory: receiptHistory,
      kpis: [
        { id: 'plans', label: 'Planos ativos', value: String(premiumCount + familiaCount), grow: '+12%', color: '#6366F1' },
        { id: 'users', label: 'Total de usuários', value: String(totalUsers), grow: '+24%', color: '#8B5CF6' },
        { id: 'expiring', label: 'Planos a vencer', value: String(dbStats.expiring_soon || '0'), grow: '-5%', color: '#F59E0B' },
        { id: 'trainers', label: 'Personais', value: String(dbStats.total_trainers || '0'), grow: '+8%', color: '#10B981' },
        { id: 'gyms', label: 'Academias', value: String(dbStats.total_gyms_real || '0'), grow: '+3%', color: '#EF4444' },
        { id: 'stripe_plans', label: 'Planos', value: String(totalStripePlans), grow: '+0%', color: '#BBF246' },
      ],
      financeKpis: [
        { id: 'revenue', label: 'Faturamento', value: `R$ ${grossRevenueCurrent.toLocaleString('pt-BR')}`, grow: revenueGrowth, color: '#6366F1' },
        { id: 'ltv', label: 'Venture LTV', value: `R$ ${ltv.toFixed(2)}`, grow: '+15%', color: '#BBF246' },
        { id: 'cost', label: 'Custo App', value: `R$ ${monthlyCost.toFixed(2)}`, grow: '-2%', color: '#94A3B8' },
        { id: 'churn', label: 'Taxa Churn', value: `${churnRate}%`, grow: churnStatus === 'green' ? '-2%' : '+5%', color: churnStatus === 'green' ? '#10B981' : '#EF4444' },
      ],
      revenue: {
        current: grossRevenueCurrent,
        growth: revenueGrowth,
        chart: revenueData,
      },
      planDistribution: [
        { label: "Família", count: familiaCount, percent: Math.round((familiaCount / (paidCount || 1)) * 100), color: "#10B981" },
        { label: "Premium", count: premiumCount, percent: Math.round((premiumCount / (paidCount || 1)) * 100), color: "#6366F1" },
        { label: "Free", count: freeCount, percent: Math.round((freeCount / (totalUsers || 1)) * 100), color: "#94A3B8" },
      ],
      churn: {
        rate: churnRate,
        status: churnStatus,
        count: churned30d
      },
      ltv: {
        value: ltv,
        arpu: arpu
      },
      globalStats: {
        appointments: dbStats.total_appointments,
        posts: dbStats.total_posts,
        communities: dbStats.total_communities,
        workouts: dbStats.total_workouts,
        admins: dbStats.total_admins
      },
      conversion: {
        rate: parseFloat(conversionRate),
        totalUsers,
        premiumCount: paidCount,
      },
      churn: {
        rate: parseFloat(churnRate),
        churned: churned30d,
        status: churnStatus,
      },
      operations: {
        activeGyms: parseInt(dbStats.total_gyms_real || 0),
        pendingRegistrations: parseInt(dbStats.expiring_soon || 0),
        totalWorkouts: parseInt(dbStats.total_workouts || 0),
        totalCommunities: parseInt(dbStats.total_communities || 0),
        totalStripePlans: totalStripePlans,
      },
    });

  } catch (err) {
    console.error('[dashboard-stats]', err);
    res.status(500).json({ error: "Erro ao carregar dashboard." });
  }
});

// Listagem de usuários com plano ativo para drill-down no admin
app.get("/api/admin/active-users", verifyToken, async (req, res) => {
  const userId = req.userId;

  try {
    const [adminCheck] = await sql`SELECT role FROM usuarios WHERE id_us = ${userId}`;
    if (!adminCheck || (adminCheck.role || "").trim().toLowerCase() !== 'admin') {
      return res.status(403).json({ error: "Acesso negado." });
    }

    const users = await sql`
      SELECT 
        id_us,
        nome,
        email,
        avatar_url as foto_url,
        plan,
        plan_expires_at,
        createdat as created_at
      FROM usuarios
      WHERE plan IN ('premium', 'familia')
      AND (plan_expires_at IS NULL OR plan_expires_at > NOW())
      ORDER BY createdat DESC
    `;

    res.json({ success: true, users });
  } catch (err) {
    console.error('[active-users]', err);
    res.status(500).json({ error: "Erro ao buscar usuários ativos." });
  }
});

// Listagem de todos os usuários do aplicativo para o admin
app.get("/api/admin/all-users", verifyToken, async (req, res) => {
  const userId = req.userId;

  try {
    const [adminCheck] = await sql`SELECT role FROM usuarios WHERE id_us = ${userId}`;
    if (!adminCheck || (adminCheck.role || "").trim().toLowerCase() !== 'admin') {
      return res.status(403).json({ error: "Acesso negado." });
    }

    const users = await sql`
      SELECT 
        id_us,
        nome,
        email,
        avatar_url as foto_url,
        plan,
        role,
        cref,
        ativo,
        createdat as created_at
      FROM usuarios
      ORDER BY createdat DESC
    `;

    res.json({ success: true, users });
  } catch (err) {
    console.error('[all-users]', err);
    res.status(500).json({ error: "Erro ao buscar todos os usuários." });
  }
});

// PATCH: Alternar status ativo/inativo (Admin)
app.patch("/api/admin/users/:id/toggle-active", verifyToken, async (req, res) => {
  const adminId = req.userId;
  const { id } = req.params;

  try {
    const [adminCheck] = await sql`SELECT role FROM usuarios WHERE id_us = ${adminId}`;
    if (!adminCheck || (adminCheck.role || "").trim().toLowerCase() !== 'admin') {
      return res.status(403).json({ error: "Acesso negado." });
    }

    const [user] = await sql`SELECT ativo FROM usuarios WHERE id_us = ${id}`;
    if (!user) return res.status(404).json({ error: "Usuário não encontrado." });

    const newStatus = user.ativo === false ? true : false;
    const [updated] = await sql`
      UPDATE usuarios SET ativo = ${newStatus} WHERE id_us = ${id} RETURNING ativo
    `;

    res.json({ success: true, ativo: updated.ativo });
  } catch (err) {
    console.error('[toggle-active]', err);
    res.status(500).json({ error: "Erro ao alternar status do usuário." });
  }
});

// PATCH: Mudar papel do usuário (Admin)
app.patch("/api/admin/users/:id/role", verifyToken, async (req, res) => {
  const adminId = req.userId;
  const { id } = req.params;
  const { role } = req.body;

  if (!role) return res.status(400).json({ error: "Papel não informado." });

  try {
    const [adminCheck] = await sql`SELECT role FROM usuarios WHERE id_us = ${adminId}`;
    if (!adminCheck || (adminCheck.role || "").trim().toLowerCase() !== 'admin') {
      return res.status(403).json({ error: "Acesso negado." });
    }

    const [updated] = await sql`
      UPDATE usuarios SET role = ${role} WHERE id_us = ${id} RETURNING id_us, role
    `;

    if (!updated) return res.status(404).json({ error: "Usuário não encontrado." });

    res.json({ success: true, role: updated.role });
  } catch (err) {
    console.error('[update-role]', err);
    res.status(500).json({ error: "Erro ao mudar papel do usuário." });
  }
});

// PATCH: Mudar plano do usuário (Admin)
app.patch("/api/admin/users/:id/plan", verifyToken, async (req, res) => {
  const adminId = req.userId;
  const { id } = req.params;
  const { plan, expiration_days } = req.body;

  if (!plan) return res.status(400).json({ error: "Plano não informado." });

  try {
    const [adminCheck] = await sql`SELECT role FROM usuarios WHERE id_us = ${adminId}`;
    if (!adminCheck || (adminCheck.role || "").trim().toLowerCase() !== 'admin') {
      return res.status(403).json({ error: "Acesso negado." });
    }

    // Calcular data de expiração se fornecida
    let expiresAt = null;
    if (plan !== 'FREE' && plan !== 'free') {
      const days = expiration_days || 30;
      expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + days);
    }

    const [updated] = await sql`
      UPDATE usuarios 
      SET 
        plan = ${plan}, 
        plan_expires_at = ${expiresAt},
        updatedat = NOW()
      WHERE id_us = ${id} 
      RETURNING id_us, plan, plan_expires_at
    `;

    if (!updated) return res.status(404).json({ error: "Usuário não encontrado." });

    res.json({ 
      success: true, 
      plan: updated.plan, 
      expires_at: updated.plan_expires_at 
    });
  } catch (err) {
    console.error('[update-plan]', err);
    res.status(500).json({ error: "Erro ao mudar plano do usuário." });
  }
});

// Listagem de usuários com plano a vencer em 30 dias
app.get("/api/admin/expiring-users", verifyToken, async (req, res) => {
  const userId = req.userId;
  try {
    const [adminCheck] = await sql`SELECT role FROM usuarios WHERE id_us = ${userId}`;
    if (!adminCheck || (adminCheck.role || "").trim().toLowerCase() !== 'admin') {
      return res.status(403).json({ error: "Acesso negado." });
    }

    const users = await sql`
      SELECT 
        id_us, nome, email, avatar_url as foto_url, plan, plan_expires_at, createdat as created_at
      FROM usuarios
      WHERE plan IN ('premium', 'familia')
      AND plan_expires_at > NOW()
      AND plan_expires_at < NOW() + INTERVAL '30 days'
      ORDER BY plan_expires_at ASC
    `;

    res.json({ success: true, users });
  } catch (err) {
    console.error('[expiring-users]', err);
    res.status(500).json({ error: "Erro ao buscar usuários a vencer." });
  }
});

// Listagem de personais/trainers
app.get("/api/admin/trainers", verifyToken, async (req, res) => {
  const userId = req.userId;
  try {
    const [adminCheck] = await sql`SELECT role FROM usuarios WHERE id_us = ${userId}`;
    if (!adminCheck || (adminCheck.role || "").trim().toLowerCase() !== 'admin') {
      return res.status(403).json({ error: "Acesso negado." });
    }

    const users = await sql`
      SELECT 
        id_us, nome, email, avatar_url as foto_url, role, cref, ativo, createdat as created_at
      FROM usuarios
      WHERE role IN ('personal', 'trainer')
      ORDER BY nome ASC
    `;

    res.json({ success: true, users });
  } catch (err) {
    console.error('[trainers]', err);
    res.status(500).json({ error: "Erro ao buscar personais." });
  }
});

// Listagem de academias
    // Nota: Rota administrativa de academias deve ser centralizada no adminGyms.js

app.get("/api/user/session-status", verifyToken, async (req, res) => {

  const userId = req.userId;

  try {
    // Testar conexão com o banco de dados antes de tentar a consulta
    try {
      await sql`SELECT 1`;
    } catch (dbError) {
      console.error("Erro na conexão com o banco de dados:", dbError);
      return res.status(503).json({
        error: "Serviço de banco de dados temporariamente indisponível.",
        details: dbError.message
      });
    }

    const [user] = await sql`
      SELECT id_us, email, username, nome, email_verified, plan, plan_expires_at, role
      FROM usuarios
      WHERE id_us = ${userId};
    `;

    if (!user) {
      return res
        .status(404)
        .json({ error: "Usuário não encontrado para a sessão ativa." });
    }

    // Obter o UUID do Supabase Auth para o usuário
    const userMapping = await getUserAuthId(user.id_us);
    const supabase_uid = userMapping ? userMapping.auth_user_id : null;

    const isPremium = user.plan === 'premium' &&
      (!user.plan_expires_at || new Date(user.plan_expires_at) > new Date());

    res.status(200).json({
      message: "Sessão ativa.",
      user: {
        id: user.id_us,
        nome: user.nome,
        username: user.username,
        email: user.email,
        isVerified: user.email_verified,
        supabase_uid: supabase_uid,
        plan: isPremium ? 'premium' : 'free',
        plan_expires_at: user.plan_expires_at,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Erro ao obter status da sessão:", error);

    // Verificar se é um erro de conexão com o banco de dados
    if (error.message && (error.message.includes('Tenant or user not found') || error.message.includes('FATAL'))) {
      return res.status(503).json({
        error: "Erro de conexão com o banco de dados. Serviço temporariamente indisponível.",
        details: "O sistema está temporariamente indisponível. Tente novamente mais tarde."
      });
    }

    res.status(500).json({
      error: "Erro interno do servidor ao obter status da sessão.",
      details: error.message,
    });
  }
});

// -------------------------------- UPLOAD DE AVATAR ---------------------------- //


// Sincronizar URLs de imagens após upload direto (Padrão de Elite)
app.put("/api/user/sync-images", verifyToken, async (req, res) => {
  const { avatar_url, banner_url } = req.body;
  const userId = req.userId;
  const now = new Date();

  try {
    if (avatar_url) {
      await sql`
        UPDATE usuarios
        SET avatar_url = ${avatar_url},
            avatar_thumbnail = ${avatar_url},
            updatedat = ${now}
        WHERE id_us = ${userId}
      `;
    }
    
    if (banner_url) {
      await sql`
        UPDATE usuarios
        SET banner_url = ${banner_url},
            updatedat = ${now}
        WHERE id_us = ${userId}
      `;
    }

    return res.status(200).json({ success: true, message: "Perfil atualizado com sucesso." });
  } catch (err) {
    console.error("Erro ao sincronizar imagens:", err);
    return res.status(500).json({ error: "Erro interno no servidor." });
  }
});


// Upload de Avatar via Base64 (Padrão de Elite: evita erros de conexão Multipart e RLS)
app.put("/api/user/avatar-base64", verifyToken, async (req, res) => {
  const { base64, mimetype } = req.body;
  const userId = req.userId;

  if (!base64) {
    return res.status(400).json({ error: "Dados base64 não enviados." });
  }

  try {
    // Converter base64 para Buffer
    const buffer = Buffer.from(base64, "base64");
    
    // Processar e salvar (usa Sharp e Mestre Key do Supabase)
    const urls = await processAndSaveAvatar(userId, buffer, mimetype || "image/jpeg");

    // Atualizar banco
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

    return res.status(200).json({ success: true, data: { photo: urls.original } });
  } catch (err) {
    console.error("Erro no upload base64 avatar:", err);
    return res.status(500).json({ error: "Erro interno no processamento via base64." });
  }
});

// Upload de Banner via Base64
app.put("/api/user/banner-base64", verifyToken, async (req, res) => {
  const { base64, mimetype } = req.body;
  const userId = req.userId;

  if (!base64) {
    return res.status(400).json({ error: "Dados base64 não enviados." });
  }

  try {
    const buffer = Buffer.from(base64, "base64");
    
    // Usamos o processador de avatar que salva numa estrutura similar
    const urls = await processAndSaveAvatar(userId, buffer, mimetype || "image/jpeg");

    const now = new Date();
    await sql`
      UPDATE usuarios
      SET banner_url = ${urls.original},
          updatedat = ${now}
      WHERE id_us = ${userId}
    `;

    return res.status(200).json({ success: true, data: { banner: urls.original } });
  } catch (err) {
    console.error("Erro no upload base64 banner:", err);
    return res.status(500).json({ error: "Erro interno no processamento de banner." });
  }
});

app.put("/api/user/avatar", verifyToken, upload.single("avatar"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Arquivo de avatar não enviado." });
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
      // Limite de tamanho ou tipo inválido
      if (err.code === "LIMIT_FILE_SIZE")
        return res.status(413).json({ error: "Arquivo excede 5MB." });
      if (err.code === "LIMIT_UNEXPECTED_FILE")
        return res
          .status(422)
          .json({ error: "Formato de imagem não suportado." });
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
    return res.status(400).json({ error: "Arquivo de banner não enviado." });
  }

  const userId = req.userId;

  try {
    // Processar & armazenar as imagens (reutilizando a lógica de avatar, mas em outro campo)
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

// ROTA GENá‰RICA: Atualizar um único campo do perfil (username ou email)
app.put("/api/user/update-field", verifyToken, async (req, res) => {
  const userId = req.userId;
  const { field, value } = req.body;

  if (!field || !value) {
    return res.status(400).json({ error: "Informe 'field' e 'value' no corpo da requisição." });
  }

  // Permitir apenas campos controlados
  const allowed = ["username", "email", "nome", "banner_url"];
  if (!allowed.includes(field)) {
    return res.status(400).json({ error: "Campo inválido. Apenas 'username', 'email', 'nome' ou 'banner_url' são permitidos." });
  }

  try {
    const [current] = await sql`SELECT username, email FROM usuarios WHERE id_us = ${userId}`;
    if (!current) return res.status(404).json({ error: "Usuário não encontrado." });

    const now = new Date();

    // Se não houver alteração no campo solicitado, retorna sem mudanças
    if (current[field] === value) {
      return res.status(200).json({ success: true, message: "Nenhuma alteração necessária.", data: { [field]: value } });
    }

    // Verificações de unicidade + atualização (somente do campo solicitado)
    if (field === "username") {
      const existing = await sql`SELECT id_us FROM usuarios WHERE username = ${value} AND id_us != ${userId}`;
      if (existing.length > 0) {
        return res.status(409).json({ error: "Username já está em uso por outro usuário." });
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
        return res.status(409).json({ error: "E-mail já está em uso por outro usuário." });
      }

      const verificationCode = generateVerificationCode();
      const verificationExpiresAt = new Date(Date.now() + 15 * 60 * 1000);

      // Atualiza somente o email; NáƒO altera/zera a coluna username
      await sql`
        UPDATE usuarios
        SET email = ${value}, email_verified = FALSE, verification_code = ${verificationCode}, verification_code_expires_at = ${verificationExpiresAt}, updatedat = ${now}
        WHERE id_us = ${userId}
      `;

      // Tenta enviar e-mail (não bloqueante)
      try {
        await sendVerificationEmail(value, verificationCode);
      } catch (err) {
        console.warn("Falha ao enviar e-mail de verificação após alteração de e-mail (update-field):", err);
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

// Lista de trainers (basic, defensivo - retorna usuários como trainers quando aplicável) ✅
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

    // Se houver token, tentamos obter o role do requester (permitir personalizações)
    let requesterRole = null;
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const sessionId = authHeader.split(' ')[1];
      const [r] = await sql`SELECT id_us, role FROM usuarios WHERE session_id = ${sessionId}`;
      if (r) requesterRole = r.role || null;
    }

    if (hasRoleCol) {
      // Usar a coluna role (mais performático quando indexado)
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

    // Fallback: inferir trainers pelo tipo_documento = 'CNPJ' ou por presença em trainer_posts
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

// Detalhe de um trainer (busca por id) ✅
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

// Lista de posts do trainer (se existir tabela trainer_posts) ✅
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

// GET: List personals with complete profile data (usuarios + personal_profiles) ✅
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
  // Permissão: apenas o próprio trainer ou admin pode atualizar
  if (String(req.userId) !== String(trainerId)) {
    // se tiver roles/admin, aqui deveria verificar; por enquanto bloqueia
    return res.status(403).json({ error: "Acesso negado. Apenas o dono pode atualizar a cover." });
  }

  if (!req.file) return res.status(400).json({ error: "Arquivo cover não enviado." });

  try {
    // Reutiliza processamento genérico (poderia ter função própria para cover)
    const urls = await processAndSaveAvatar(trainerId, req.file.buffer, req.file.mimetype);
    // Retorna URLs geradas; a gravação em DB fica a critério do backend (schema)
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
  if (!req.file) return res.status(400).json({ error: "Arquivo avatar não enviado." });
  try {
    const urls = await processAndSaveAvatar(trainerId, req.file.buffer, req.file.mimetype);
    return res.status(200).json({ success: true, data: { avatarUrl: urls.original, avatarThumb: urls.thumb96, avatarMedium: urls.thumb192, avatarLarge: urls.thumb512 } });
  } catch (err) {
    console.error("Erro em PUT /api/trainers/:id/avatar", err);
    return res.status(500).json({ error: "Erro ao processar avatar do trainer." });
  }
});

// Follow / Unfollow (só se tabela 'follows' existir)
app.post("/api/trainers/:id/follow", verifyToken, async (req, res) => {
  const trainerId = req.params.id;
  const userId = req.userId;
  try {
    // Validação de entrada
    if (!trainerId || isNaN(parseInt(trainerId, 10))) {
      return res.status(400).json({ error: "ID do trainer inválido." });
    }

    const [{ exists }] = await sql`SELECT to_regclass('public.follows') IS NOT NULL AS exists`;
    if (!exists) return res.status(501).json({ error: "Tabela 'follows' não instalada no banco. Implementação pendente." });

    // Verificar se o trainer existe antes de criar o follow
    const trainerExists = await sql`SELECT id_us FROM usuarios WHERE id_us = ${parseInt(trainerId, 10)} AND (role = 'trainer' OR role = 'personal')`;
    if (!trainerExists || trainerExists.length === 0) {
      return res.status(404).json({ error: "Trainer não encontrado." });
    }

    // Verificar se o usuário não está tentando seguir a si mesmo
    if (parseInt(trainerId, 10) === userId) {
      return res.status(400).json({ error: "Você não pode seguir a si mesmo." });
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
    // Validação de entrada
    if (!trainerId || isNaN(parseInt(trainerId, 10))) {
      return res.status(400).json({ error: "ID do trainer inválido." });
    }

    const [{ exists }] = await sql`SELECT to_regclass('public.follows') IS NOT NULL AS exists`;
    if (!exists) return res.status(501).json({ error: "Tabela 'follows' não instalada no banco. Implementação pendente." });

    await sql`DELETE FROM follows WHERE follower_user_id = ${userId} AND trainer_id = ${parseInt(trainerId, 10)}`;
    return res.status(200).json({ success: true, following: false });
  } catch (err) {
    console.error("Erro em DELETE /api/trainers/:id/follow", err);
    return res.status(500).json({ error: "Erro interno ao deixar de seguir trainer." });
  }
});

// Follow múltiplos trainers de uma vez
app.post("/api/trainers/follow-multiple", verifyToken, async (req, res) => {
  const userId = req.userId;
  const { trainerIds } = req.body;

  try {
    // Validação de entrada
    if (!Array.isArray(trainerIds) || trainerIds.length === 0) {
      return res.status(400).json({ error: "trainerIds deve ser um array não vazio." });
    }

    if (trainerIds.length > 100) {
      return res.status(400).json({ error: "Máximo de 100 trainers por vez." });
    }

    const [{ exists }] = await sql`SELECT to_regclass('public.follows') IS NOT NULL AS exists`;
    if (!exists) return res.status(501).json({ error: "Tabela 'follows' não instalada no banco. Implementação pendente." });

    // Filtra IDs válidos (números)
    const validIds = trainerIds.filter(id => !isNaN(parseInt(id, 10)));

    if (validIds.length === 0) {
      return res.status(400).json({ error: "Nenhum ID de trainer válido fornecido." });
    }

    // Insere múltiplos follows (ignorando conflitos)
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
    return res.status(500).json({ error: "Erro interno ao seguir múltiplos trainers." });
  }
});

// --------------------- SOCIAL / SEGUIR USUÁRIOS --------------------- //

// Seguir um usuário

// --- ROTAS DE SEGUIMENTO (AVANÇADAS) ---

// Seguir um usuário (com suporte a solicitação pendente)
app.post("/api/user/:id/follow", verifyToken, async (req, res) => {
  const followedUserId = await resolveUserId(req.params.id);
  const followerUserId = req.userId;

  if (!followedUserId || isNaN(followedUserId)) {
    return res.status(404).json({ error: "Usuário não encontrado." });
  }

  if (followedUserId === followerUserId) {
    return res.status(400).json({ error: "Você não pode seguir a si mesmo." });
  }

  try {
    const [existing] = await sql`
      SELECT status FROM follows 
      WHERE follower_user_id = ${followerUserId} AND followed_user_id = ${followedUserId}
    `;

    if (existing) {
       // Se já existe, o POST funciona como toggle (desfaz o seguimento)
       await sql`DELETE FROM follows WHERE follower_user_id = ${followerUserId} AND followed_user_id = ${followedUserId}`;
       await sql`DELETE FROM notifications WHERE sender_id = ${followerUserId} AND user_id = ${followedUserId} AND type IN ('follow', 'follow_request')`;
       return res.status(200).json({ success: true, isFollowing: false });
    }

    const status = 'pending'; 
    await sql`
      INSERT INTO follows (follower_user_id, followed_user_id, status)
      VALUES (${followerUserId}, ${followedUserId}, ${status})
      ON CONFLICT (follower_user_id, followed_user_id) DO UPDATE SET status = ${status}
    `;

    // REMOVIDO: Não inserir notificação em atividade para o pedido enviado (ficará apenas na aba solicitações)
    
    return res.status(200).json({ success: true, isFollowing: false, status });
  } catch (err) {
    console.error("Erro ao seguir usuário:", err);
    return res.status(500).json({ error: "Erro interno ao seguir usuário." });
  }
});

// Parar de seguir um usuário (Unfollow)
app.delete("/api/user/:id/unfollow", verifyToken, async (req, res) => {
  const followedUserId = await resolveUserId(req.params.id);
  const followerUserId = req.userId;

  try {
    await sql`
      DELETE FROM follows 
      WHERE follower_user_id = ${followerUserId} AND followed_user_id = ${followedUserId}
    `;
    
    // Remover notificações de follow associadas
    await sql`
      DELETE FROM notifications 
      WHERE sender_id = ${followerUserId} AND user_id = ${followedUserId} AND type IN ('follow', 'follow_request')
    `;

    return res.status(200).json({ success: true, message: "Deixou de seguir com sucesso." });
  } catch (err) {
    console.error("Erro ao desassociar follow:", err);
    return res.status(500).json({ error: "Erro interno ao deixar de seguir." });
  }
});

// Verificar status de seguimento
app.get("/api/user/:id/follow-status", verifyToken, async (req, res) => {
  const followedUserId = await resolveUserId(req.params.id);
  const followerUserId = req.userId;

  try {
    const [follow] = await sql`
      SELECT status FROM follows 
      WHERE follower_user_id = ${followerUserId} AND followed_user_id = ${followedUserId}
    `;
    
    return res.status(200).json({ 
      isFollowing: follow ? (follow.status === 'accepted') : false,
      status: follow ? follow.status : null 
    });
  } catch (err) {
    console.error("Erro ao buscar status de follow:", err);
    return res.status(500).json({ isFollowing: false });
  }
});


// -------------------- GRAFO / REDE DE SEGUIDORES -------------------- //

// Retorna um subgrafo (nodes + links) para um usuário, com profundidade configurável.
// Query params:
//  - userId (opcional): id do usuário raiz; se ausente, usa o usuário autenticado
//  - depth (opcional): profundidade de busca (padrão 2, máximo 5)
//  - maxNodes (opcional): limite de nós retornados (padrão 500, máximo 2000)
//  - direction (opcional): 'out' (seguindo), 'in' (seguidores) ou 'both' (padrão)
app.get("/api/graph/network", verifyToken, async (req, res) => {
  try {
    const startId = req.query.userId ? parseInt(req.query.userId, 10) : req.userId;
    if (!startId) return res.status(400).json({ error: "userId não informado e sessão não encontrada." });

    let depth = parseInt(req.query.depth || "2", 10);
    depth = Number.isNaN(depth) ? 2 : Math.min(Math.max(depth, 1), 5);

    let maxNodes = parseInt(req.query.maxNodes || "500", 10);
    maxNodes = Number.isNaN(maxNodes) ? 500 : Math.min(Math.max(maxNodes, 50), 2000);

    const direction = (req.query.direction || "both").toLowerCase();

    // Verifica se tabela 'follows' existe
    const [{ exists }] = await sql`SELECT to_regclass('public.follows') IS NOT NULL AS exists`;
    if (!exists) return res.status(501).json({ error: "Tabela 'follows' não instalada. Execute as migrations para habilitar a rede de seguidores." });

    // Monta CTE recursivo dependendo da direção solicitada
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

    // Se só tiver o nó raiz, retornamos apenas ele
    if (ids.length === 0) {
      return res.status(200).json({ nodes: [], links: [] });
    }

    // Busca dados dos usuários (nós)
    const users = await sql`
      SELECT id_us AS id, nome AS name, username, avatar_url, role
      FROM usuarios
      WHERE id_us = ANY(${ids})
      LIMIT ${maxNodes}
    `;

    // Busca arestas (relacionamentos) entre os nós retornados
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

// --- NOVAS ROTAS DE NOTIFICAÇÕES E SEGUIMENTO --- //

// Obter notificações do usuário
app.get("/api/user/notifications", verifyToken, async (req, res) => {
  const userId = req.userId;
  console.log(`[DEBUG] Buscando notificações para o usuário id_us: ${userId}`);
  try {
    const notifications = await sql`
      SELECT 
        n.*, 
        u.nome as sender_name, 
        u.username as sender_username, 
        u.avatar_url as sender_avatar
      FROM notifications n
      JOIN usuarios u ON n.sender_id = u.id_us
      WHERE n.user_id = ${userId}
      ORDER BY n.created_at DESC
      LIMIT 50
    `;
    console.log(`[DEBUG] Notificações encontradas: ${notifications.length}`);
    return res.status(200).json({ success: true, data: notifications });
  } catch (err) {
    console.error("Erro ao buscar notificações:", err);
    return res.status(500).json({ error: "Erro ao buscar notificações." });
  }
});

// Marcar uma notificação como lida
app.put("/api/user/notifications/:id/read", verifyToken, async (req, res) => {
  const { id } = req.params;
  const userId = req.userId;
  try {
    await sql`
      UPDATE notifications 
      SET "read" = TRUE 
      WHERE id = ${id} AND user_id = ${userId}
    `;
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("Erro ao marcar notificação como lida:", err);
    return res.status(500).json({ error: "Erro ao atualizar notificação." });
  }
});

// Marcar todas as notificações como lidas (Limpar)
app.put("/api/user/notifications/read-all", verifyToken, async (req, res) => {
  const userId = req.userId;
  try {
    await sql`
      UPDATE notifications 
      SET "read" = TRUE 
      WHERE user_id = ${userId} AND "read" = FALSE
    `;
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("Erro ao limpar notificações:", err);
    return res.status(500).json({ error: "Erro ao limpar notificações." });
  }
});

// Obter solicitações de amizade pendentes
app.get("/api/user/follow-requests", verifyToken, async (req, res) => {
  const userId = req.userId;
  console.log(`[DEBUG] Buscando solicitações para o usuário id_us: ${userId}`);
  try {
    const requests = await sql`
      SELECT 
        u.id_us as id, 
        u.nome as name, 
        u.username, 
        u.avatar_url as photo,
        f.created_at
      FROM follows f
      JOIN usuarios u ON f.follower_user_id = u.id_us
      WHERE f.followed_user_id = ${userId} AND f.status = 'pending'
      ORDER BY f.created_at DESC
    `;
    console.log(`[DEBUG] Solicitações encontradas: ${requests.length}`);
    return res.status(200).json({ success: true, data: requests });
  } catch (err) {
    console.error("Erro ao buscar solicitações:", err);
    return res.status(500).json({ error: "Erro ao buscar solicitações." });
  }
});

// Responder a uma solicitação de amizade
app.post("/api/user/follow-requests/:senderId/respond", verifyToken, async (req, res) => {
  const userId = req.userId;
  const { senderId } = req.params;
  const { accept } = req.body;

  try {
    if (accept) {
      await sql`
        UPDATE follows 
        SET status = 'accepted' 
        WHERE follower_user_id = ${senderId} AND followed_user_id = ${userId}
      `;
      
      // Criar notificação para quem enviou a solicitação (User A)
      await sql`
        INSERT INTO notifications (user_id, type, sender_id, message)
        VALUES (${senderId}, 'follow_accepted', ${userId}, 'aceitou sua solicitação de amizade.')
      `;

      // Criar notificação para quem recebeu e aceitou a solicitação (User B)
      // Assim fica o registro em Atividade: "@UserA agora vocês se seguem"
      await sql`
        INSERT INTO notifications (user_id, type, sender_id, message)
        VALUES (${userId}, 'follow', ${senderId}, 'agora vocês se seguem.')
      `;
    } else {
      await sql`
        DELETE FROM follows 
        WHERE follower_user_id = ${senderId} AND followed_user_id = ${userId}
      `;
    }

    // Remover a notificação de solicitação original
    await sql`
      DELETE FROM notifications 
      WHERE user_id = ${userId} AND sender_id = ${senderId} AND type = 'follow_request'
    `;

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("Erro ao responder solicitação:", err);
    return res.status(500).json({ error: "Erro ao processar resposta." });
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

// Obter o feed global de posts
app.get("/api/feed", verifyToken, async (req, res) => {
  try {
    // Garantir que as tabelas de interação existam para evitar erro 500
    await sql`CREATE TABLE IF NOT EXISTS post_likes (
      id SERIAL PRIMARY KEY,
      post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
      id_us INTEGER REFERENCES usuarios(id_us) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(post_id, id_us)
    )`;

    await sql`CREATE TABLE IF NOT EXISTS post_saves (
      id SERIAL PRIMARY KEY,
      post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
      id_us INTEGER REFERENCES usuarios(id_us) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(post_id, id_us)
    )`;

    // Busca posts recentes com informações do autor e status de like/save para o usuário atual
    const posts = await sql`
      SELECT 
        p.*, 
        u.nome as author_name, 
        u.username as author_username,
        u.avatar_url as author_avatar,
        u.verificado as author_verified,
        EXISTS(SELECT 1 FROM post_likes WHERE post_id = p.id AND id_us = ${req.userId}) as is_liked,
        EXISTS(SELECT 1 FROM post_saves WHERE post_id = p.id AND id_us = ${req.userId}) as is_saved
      FROM posts p
      JOIN usuarios u ON p.id_us = u.id_us
      WHERE p.archived = FALSE
      ORDER BY p.created_at DESC
      LIMIT 20
    `;

    // Transformar para o formato que o frontend espera
    const formattedPosts = posts.map(p => ({
      post_id: p.id.toString(),
      type: p.tipo || 'POST',
      author: {
        user_id: p.id_us.toString(),
        username: p.author_username || p.author_name || `user_${p.id_us}`,
        full_name: p.author_name || '',
        avatar_url: p.author_avatar || '',
        is_verified: p.author_verified || false,
        is_following: false,
      },
      media: [{
        media_id: `m_${p.id}`,
        media_url: p.image_url,
        thumbnail_url: p.image_url,
        media_type: 'IMAGE',
        width: 1080,
        height: 1080,
        position: 0,
      }],
      caption: p.legenda || '',
      location: null,
      hashtags: [],
      mentions: [],
      like_count: parseInt(p.likes_count) || 0,
      comment_count: parseInt(p.comments_count) || 0,
      share_count: parseInt(p.share_count) || 0,
      save_count: 0,
      is_liked: p.is_liked === true || p.is_liked === 't' || p.is_liked === 1,
      is_saved: p.is_saved === true || p.is_saved === 't' || p.is_saved === 1,
      likes_hidden: false,
      comments_off: false,
      is_pinned: false,
      is_archived: false,
      created_at: p.created_at,
      time_ago: 'Recém postado',
    }));

    res.json({ 
      success: true, 
      posts: formattedPosts,
      next_cursor: null,
      has_more: false 
    });
  } catch (err) {
    console.error("Erro em GET /api/feed:", err);
    res.status(500).json({ error: "Erro ao buscar feed." });
  }
});

// Obter um post específico por ID
app.get("/api/posts/:id", verifyToken, async (req, res) => {
  const postId = req.params.id;
  try {
    const [post] = await sql`
      SELECT 
        p.*, 
        u.nome as author_name, 
        u.username as author_username,
        u.avatar_url as author_avatar,
        u.verificado as author_verified,
        EXISTS(SELECT 1 FROM post_likes WHERE post_id = p.id AND id_us = ${req.userId}) as is_liked,
        EXISTS(SELECT 1 FROM post_saves WHERE post_id = p.id AND id_us = ${req.userId}) as is_saved
      FROM posts p
      JOIN usuarios u ON p.id_us = u.id_us
      WHERE p.id = ${parseInt(postId, 10)}
    `;

    if (!post) {
      return res.status(404).json({ error: "Post não encontrado." });
    }

    // Transformar para o formato que o frontend espera
    const formattedPost = {
      post_id: post.id.toString(),
      type: post.tipo || 'POST',
      author: {
        user_id: post.id_us.toString(),
        username: post.author_username || post.author_name || `user_${post.id_us}`,
        full_name: post.author_name || '',
        avatar_url: post.author_avatar || '',
        is_verified: post.author_verified || false,
        is_following: false,
      },
      media: [{
        media_id: `m_${post.id}`,
        media_url: post.image_url,
        thumbnail_url: post.image_url,
        media_type: 'IMAGE',
        width: 1080,
        height: 1080,
        position: 0,
      }],
      caption: post.legenda || '',
      location: null,
      hashtags: [],
      mentions: [],
      like_count: parseInt(post.likes_count) || 0,
      comment_count: parseInt(post.comments_count) || 0,
      share_count: parseInt(post.share_count) || 0,
      save_count: 0,
      is_liked: post.is_liked === true || post.is_liked === 't' || post.is_liked === 1,
      is_saved: post.is_saved === true || post.is_saved === 't' || post.is_saved === 1,
      likes_hidden: false,
      comments_off: false,
      is_pinned: false,
      is_archived: false,
      created_at: post.created_at,
      time_ago: 'Postagem',
    };

    res.json({ 
      success: true, 
      post: formattedPost 
    });
  } catch (err) {
    console.error(`Erro em GET /api/posts/${postId}:`, err);
    res.status(500).json({ error: "Erro ao buscar detalhes do post." });
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
      WHERE id_us = ${userId} AND archived = FALSE
      ORDER BY created_at DESC
    `;

    return res.status(200).json({ success: true, data: posts });
  } catch (err) {
    console.error(`Erro em GET /api/user/${req.params.id}/posts`, err);
    return res.status(500).json({ error: "Erro ao buscar posts." });
  }
});

// Arquivar um post
app.post("/api/user/posts/:id/archive", verifyToken, async (req, res) => {
  const postId = req.params.id;
  const userId = req.userId;
  try {
    const [post] = await sql`
      UPDATE posts SET archived = TRUE
      WHERE id = ${parseInt(postId, 10)} AND id_us = ${userId}
      RETURNING id
    `;
    if (!post) return res.status(404).json({ success: false, message: "Post não encontrado ou sem permissão." });
    return res.status(200).json({ success: true, message: "Post arquivado com sucesso." });
  } catch (err) {
    console.error("Erro em POST /api/user/posts/:id/archive:", err);
    return res.status(500).json({ error: "Erro ao arquivar post." });
  }
});

// Desarquivar um post
app.post("/api/user/posts/:id/unarchive", verifyToken, async (req, res) => {
  const postId = req.params.id;
  const userId = req.userId;
  try {
    const [post] = await sql`
      UPDATE posts SET archived = FALSE
      WHERE id = ${parseInt(postId, 10)} AND id_us = ${userId}
      RETURNING id
    `;
    if (!post) return res.status(404).json({ success: false, message: "Post não encontrado ou sem permissão." });
    return res.status(200).json({ success: true, message: "Post desarquivado com sucesso." });
  } catch (err) {
    console.error("Erro em POST /api/user/posts/:id/unarchive:", err);
    return res.status(500).json({ error: "Erro ao desarquivar post." });
  }
});

// Listar posts arquivados do usuário logado
app.get("/api/user/posts/archived", verifyToken, async (req, res) => {
  const userId = req.userId;
  try {
    const posts = await sql`
      SELECT * FROM posts
      WHERE id_us = ${userId} AND archived = TRUE
      ORDER BY created_at DESC
    `;
    return res.status(200).json({ success: true, data: posts });
  } catch (err) {
    console.error("Erro em GET /api/user/posts/archived:", err);
    return res.status(500).json({ error: "Erro ao buscar posts arquivados." });
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

// Função para garantir integridade das tabelas de posts
async function ensurePostInteractionTables() {
  try {
    // Adicionar colunas de contagem se não existirem
    await sql`ALTER TABLE posts ADD COLUMN IF NOT EXISTS likes_count INTEGER DEFAULT 0`;
    await sql`ALTER TABLE posts ADD COLUMN IF NOT EXISTS comments_count INTEGER DEFAULT 0`;
    await sql`ALTER TABLE posts ADD COLUMN IF NOT EXISTS share_count INTEGER DEFAULT 0`;

    // Tabela de Likes
    await sql`CREATE TABLE IF NOT EXISTS post_likes (
      id SERIAL PRIMARY KEY,
      post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
      id_us INTEGER REFERENCES usuarios(id_us) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(post_id, id_us)
    )`;

    // Tabela de Salvos
    await sql`CREATE TABLE IF NOT EXISTS post_saves (
      id SERIAL PRIMARY KEY,
      post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
      id_us INTEGER REFERENCES usuarios(id_us) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(post_id, id_us)
    )`;

    // Tabela de Comentários
    await sql`CREATE TABLE IF NOT EXISTS post_comments (
      id SERIAL PRIMARY KEY,
      post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
      id_us INTEGER REFERENCES usuarios(id_us) ON DELETE CASCADE,
      comentario TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )`;
  } catch (err) {
    console.error("Erro ao garantir tabelas de interação:", err);
  }
}

// Chamar ao carregar
ensurePostInteractionTables();

// Obter comentários de um post
app.get("/api/user/posts/:id/comments", verifyToken, async (req, res) => {
  const postId = req.params.id;
  try {
    const comments = await sql`
      SELECT 
        c.id,
        c.post_id,
        c.id_us as user_id,
        c.comentario,
        c.created_at,
        u.nome,
        u.username,
        u.avatar_url as photo
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
  const { comentario, text, texto } = req.body;
  const commentText = comentario || text || texto;

  if (!commentText) return res.status(400).json({ error: "Comentário é obrigatório." });

  try {
    const [newComment] = await sql`
      INSERT INTO post_comments (post_id, id_us, comentario)
      VALUES (${parseInt(postId, 10)}, ${userId}, ${commentText})
      RETURNING *
    `;

    // Incrementar contador de comentários
    await sql`UPDATE posts SET comments_count = comments_count + 1 WHERE id = ${parseInt(postId, 10)}`;

    // Criar notificação para o autor do post
    const [post] = await sql`SELECT id_us FROM posts WHERE id = ${parseInt(postId, 10)}`;
    if (post && post.id_us !== userId) {
      await sql`
        INSERT INTO notifications (user_id, type, sender_id, reference_id, message)
        VALUES (${post.id_us}, 'comment', ${userId}, ${parseInt(postId, 10)}, 'comentou na sua publicação.')
      `;
    }

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
      await sql`DELETE FROM post_likes WHERE id = ${existing.id}`;
      // Remover notificação de curtida se existir
      await sql`DELETE FROM notifications WHERE user_id = (SELECT id_us FROM posts WHERE id = ${parseInt(postId, 10)}) AND sender_id = ${userId} AND type = 'like' AND reference_id = ${parseInt(postId, 10)}`;
      await sql`UPDATE posts SET likes_count = GREATEST(0, likes_count - 1) WHERE id = ${parseInt(postId, 10)}`;
      return res.status(200).json({ success: true, isLiked: false });
    } else {
      await sql`INSERT INTO post_likes (post_id, id_us) VALUES (${parseInt(postId, 10)}, ${userId})`;
      await sql`UPDATE posts SET likes_count = likes_count + 1 WHERE id = ${parseInt(postId, 10)}`;
      
      // Criar notificação para o autor do post
      const [post] = await sql`SELECT id_us FROM posts WHERE id = ${parseInt(postId, 10)}`;
      if (post && post.id_us !== userId) {
        await sql`
          INSERT INTO notifications (user_id, type, sender_id, reference_id, message)
          VALUES (${post.id_us}, 'like', ${userId}, ${parseInt(postId, 10)}, 'curtiu sua publicação.')
        `;
      }
      
      return res.status(200).json({ success: true, isLiked: true });
    }
  } catch (err) {
    console.error("Erro ao curtir post:", err);
    return res.status(500).json({ error: "Erro interno ao curtir post." });
  }
});

// Salvar/Remover post salvo (Toggle)
app.post("/api/user/posts/:id/save", verifyToken, async (req, res) => {
  const postId = req.params.id;
  const userId = req.userId;

  try {
    const [existing] = await sql`
      SELECT id FROM post_saves WHERE post_id = ${parseInt(postId, 10)} AND id_us = ${userId}
    `;

    if (existing) {
      await sql`DELETE FROM post_saves WHERE id = ${existing.id}`;
      return res.status(200).json({ success: true, isSaved: false });
    } else {
      await sql`INSERT INTO post_saves (post_id, id_us) VALUES (${parseInt(postId, 10)}, ${userId})`;
      return res.status(200).json({ success: true, isSaved: true });
    }
  } catch (err) {
    console.error("Erro ao salvar post:", err);
    return res.status(500).json({ error: "Erro interno ao salvar post." });
  }
});

// Registrar compartilhamento
app.post("/api/user/posts/:id/share", verifyToken, async (req, res) => {
  const postId = req.params.id;
  try {
    await sql`UPDATE posts SET share_count = share_count + 1 WHERE id = ${parseInt(postId, 10)}`;
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("Erro ao compartilhar post:", err);
    return res.status(500).json({ error: "Erro interno ao registrar compartilhamento." });
  }
});

// Excluir um comentário
app.delete("/api/user/posts/comments/:id", verifyToken, async (req, res) => {
  const commentId = req.params.id;
  const userId = req.userId;

  try {
    const [comment] = await sql`SELECT post_id, id_us FROM post_comments WHERE id = ${parseInt(commentId, 10)}`;
    if (!comment) return res.status(404).json({ error: "Comentário não encontrado." });

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

    // Excluir dependências (opcional se houver ON DELETE CASCADE, mas bom reforçar)
    await sql`DELETE FROM post_likes WHERE post_id = ${parseInt(postId, 10)}`;
    await sql`DELETE FROM post_comments WHERE post_id = ${parseInt(postId, 10)}`;
    await sql`DELETE FROM post_saves WHERE post_id = ${parseInt(postId, 10)}`;
    
    await sql`DELETE FROM posts WHERE id = ${parseInt(postId, 10)}`;
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("Erro ao excluir post:", err);
    return res.status(500).json({ error: "Erro interno ao excluir post." });
  }
});

// Editar um post
app.patch("/api/user/posts/:id", verifyToken, async (req, res) => {
  const postId = req.params.id;
  const userId = req.userId;
  const { legenda } = req.body;

  try {
    const [post] = await sql`SELECT id_us FROM posts WHERE id = ${parseInt(postId, 10)}`;
    if (!post) return res.status(404).json({ error: "Post não encontrado." });

    if (post.id_us !== userId) {
      return res.status(403).json({ error: "Não autorizado." });
    }

    const [updatedPost] = await sql`
      UPDATE posts SET legenda = ${legenda}
      WHERE id = ${parseInt(postId, 10)}
      RETURNING *
    `;
    return res.status(200).json({ success: true, data: updatedPost });
  } catch (err) {
    console.error("Erro ao editar post:", err);
    return res.status(500).json({ error: "Erro interno ao editar post." });
  }
});

// Arquivar um post
app.post("/api/user/posts/:id/archive", verifyToken, async (req, res) => {
  const postId = req.params.id;
  const userId = req.userId;

  try {
    const [post] = await sql`SELECT id_us FROM posts WHERE id = ${parseInt(postId, 10)}`;
    if (!post) return res.status(404).json({ error: "Post não encontrado." });

    if (post.id_us !== userId) {
      return res.status(403).json({ error: "Não autorizado." });
    }

    await sql`UPDATE posts SET archived = TRUE WHERE id = ${parseInt(postId, 10)}`;
    return res.status(200).json({ success: true, message: "Post arquivado com sucesso!" });
  } catch (err) {
    console.error("Erro ao arquivar post:", err);
    return res.status(500).json({ error: "Erro interno ao arquivar post." });
  }
});

// Notifications (consulta básica se tabela existir)
app.get("/api/notifications", verifyToken, async (req, res) => {
  const userId = req.userId;
  try {
    const [{ exists }] = await sql`SELECT to_regclass('public.notifications') IS NOT NULL AS exists`;
    if (!exists) return res.status(200).json({ data: [] });

    // Join com usuarios para obter dados do sender (quem interagiu)
    const data = await sql`
      SELECT 
        n.id, 
        n.message, 
        n.type, 
        n.read, 
        n.created_at, 
        n.reference_id,
        u.username as sender_username,
        u.avatar_url as sender_avatar
      FROM notifications n
      LEFT JOIN usuarios u ON n.sender_id = u.id_us
      WHERE n.user_id = ${userId}
      ORDER BY n.created_at DESC
      LIMIT 100
    `;
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error("Erro em GET /api/notifications", err);
    return res.status(500).json({ error: "Erro interno ao buscar notificações." });
  }
});

app.put("/api/notifications/:id/read", verifyToken, async (req, res) => {
  const userId = req.userId;
  const id = req.params.id;
  try {
    const [{ exists }] = await sql`SELECT to_regclass('public.notifications') IS NOT NULL AS exists`;
    if (!exists) return res.status(501).json({ error: "Tabela 'notifications' não instalada." });
    await sql`UPDATE notifications SET read = true WHERE id = ${id} AND user_id = ${userId}`;
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("Erro em PUT /api/notifications/:id/read", err);
    return res.status(500).json({ error: "Erro interno ao marcar notificacao." });
  }
});

// Endpoint para gerar signed upload (placeholder quando não houver S3 direto)
app.post("/api/uploads/sign", verifyToken, async (req, res) => {
  // Este endpoint pode ser implementado para S3/GCS, aqui oferecemos comportamento mínimo
  const { filename, contentType, purpose } = req.body || {};
  if (!filename || !contentType) return res.status(400).json({ error: "Informe filename e contentType." });
  if (!supabase) return res.status(501).json({ error: "Signed uploads não configurados neste ambiente. Use multipart ou configure storage." });
  // Como fallback retornamos um suggested public path e instruções
  const suggestedKey = `${purpose || 'uploads'}/${uuidv4()}_${filename}`;
  return res.status(200).json({ uploadUrl: null, publicUrl: `supabase://${AVATAR_BUCKET}/${suggestedKey}`, message: "Presigned upload não implementado no servidor; faça upload via backend ou configure S3." });
});

// -------------------------------- DIETAS ---------------------------- //

app.post("/api/dietas", verifyToken, checkFreePlanLimit('dietas'), async (req, res) => {
  console.log("=== INá CIO DA ROTA POST /api/dietas ===");
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

  // Log dos dados extraídos
  console.log("--- DADOS EXTRAá DOS ---");
  console.log("Nome:", nome);
  console.log("Descrição:", descricao);
  console.log("Image URL:", imageurl);
  console.log("Categoria:", categoria);
  console.log("Calorias:", calorias);
  console.log("Tempo de preparo:", tempo_preparo);
  console.log("Gordura:", gordura);
  console.log("Proteína:", proteina);
  console.log("Carboidratos:", carboidratos);

  // Validação com logs detalhados
  console.log("--- VALIDAÇÃO DOS DADOS ---");
  const validationErrors = [];

  if (!nome) {
    validationErrors.push("Nome é obrigatório");
    console.log("â Œ ERRO: Nome não fornecido");
  } else {
    console.log("✅ Nome válido:", nome);
  }

  if (!descricao) {
    validationErrors.push("Descrição é obrigatória");
    console.log("â Œ ERRO: Descrição não fornecida");
  } else {
    console.log("✅ Descrição válida:", descricao.substring(0, 50) + "...");
  }

  if (!imageurl) {
    validationErrors.push("URL da imagem é obrigatória");
    console.log("â Œ ERRO: URL da imagem não fornecida");
  } else {
    console.log("✅ URL da imagem válida:", imageurl);
  }

  if (!categoria) {
    validationErrors.push("Categoria é obrigatória");
    console.log("â Œ ERRO: Categoria não fornecida");
  } else {
    console.log("✅ Categoria válida:", categoria);
  }

  if (validationErrors.length > 0) {
    console.log("--- FALHA NA VALIDAÇÃO ---");
    console.log("Erros encontrados:", validationErrors);
    console.log("=== FIM DA ROTA POST /api/dietas (ERRO 400) ===");
    return res.status(400).json({
      error: "Dados obrigatórios não fornecidos.",
      details: validationErrors,
    });
  }

  console.log("✅ Todas as validações passaram");

  try {
    console.log("--- BUSCANDO DADOS DO AUTOR ---");
    console.log("Buscando usuário com ID:", userId);

    const [author] =
      await sql`SELECT nome, username, email, avatar_url FROM usuarios WHERE id_us = ${userId}`;

    if (!author) {
      console.log("ERRO: Usuário autor não encontrado no banco de dados");
      console.log("=== FIM DA ROTA POST /api/dietas (ERRO 404) ===");
      return res.status(404).json({ error: "Usuário autor não encontrado." });
    }

    console.log("✅ Autor encontrado:", {
      nome: author.nome,
      username: author.username,
      email: author.email,
    });

    const authorName = author.nome || author.username || null;
    const authorAvatarUrl = author.avatar_url || getGravatarUrl(author.email);

    console.log("--- PREPARANDO DADOS PARA INSERÇÃO ---");
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

    console.log("✅ Dieta inserida com sucesso no banco de dados");
    console.log("--- DADOS DA DIETA CRIADA ---");
    console.log("ID da dieta:", newDieta.id_dieta);
    console.log("Nome:", newDieta.nome);
    console.log("Categoria:", newDieta.categoria);
    console.log("Data de criação:", newDieta.createdat);

    console.log("--- RESPOSTA DE SUCESSO ---");
    console.log("Status: 201 - Created");
    console.log("=== FIM DA ROTA POST /api/dietas (SUCESSO) ===");

    res.status(201).json({
      message: "Dieta criada com sucesso!",
      data: newDieta,
    });
  } catch (error) {
    console.log("--- ERRO DURANTE A EXECUÇÃO ---");
    console.error("â Œ ERRO ao criar dieta:", error);
    console.log("Tipo do erro:", error.constructor.name);
    console.log("Código do erro:", error.code);
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
  const { categoria, mine } = req.query;

  try {
    const userIdStr = String(userId);
    
    // Filtros baseados nos parâmetros da URL
    const showOnlyMine = mine === "true";
    const categoryFilter = categoria && categoria !== "all" ? categoria : null;

    let query = sql`
      SELECT 
        d.id_us, 
        d.nome as title, 
        d.descricao as description, 
        d.imageurl as "imageUrl", 
        d.calorias as calories, 
        d.tempo_preparo as minutes, 
        d.gordura as fat, 
        d.proteina as protein, 
        d.carboidratos as carbs, 
        d.nome_autor, 
        d.avatar_autor_url, 
        d.createdat as created_at,
        d.id_dieta, 
        d.likes_count, 
        d.comments_count, 
        d.likes,
        EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(COALESCE(d.likes, '[]'::jsonb)) AS l
          WHERE l = ${userIdStr}
        ) as "isLiked"
      FROM dietas d
      WHERE 1=1
      ${categoryFilter ? sql`AND d.categoria = ${categoryFilter}` : sql``}
      ${showOnlyMine ? sql`AND d.id_us = ${userId}` : sql``}
      ORDER BY d.createdat DESC;
    `;

    console.log(`[GET DIETAS] User: ${userId}, Filtrar apenas minhas: ${showOnlyMine}, Categoria: ${categoryFilter || 'Todas'}`);
    const dietas = await query;
    console.log(`[DIET FEED] Retornando ${dietas.length} dietas. Exemplo: Diet ID ${dietas[0]?.id_dieta}, isLiked: ${dietas[0]?.isLiked}`);
    res.status(200).json({ data: dietas });
  } catch (error) {
    console.error("Erro ao listar dietas:", error);
    res.status(500).json({
      error: "Erro interno do servidor ao listar dietas.",
      details: error.message,
    });
  }
});

// GET: Detalhes de uma dieta específica
app.get("/api/dietas/:id", verifyToken, async (req, res) => {
  const userId = String(req.userId);
  const { id } = req.params;

  try {
    const [dieta] = await sql`
      SELECT 
        d.id_us, 
        d.nome as title, 
        d.descricao as description, 
        d.imageurl as "imageUrl", 
        d.calorias as calories, 
        d.tempo_preparo as minutes, 
        d.gordura as fat, 
        d.proteina as protein, 
        d.carboidratos as carbs, 
        d.nome_autor, 
        d.avatar_autor_url, 
        d.createdat as created_at,
        d.id_dieta, 
        d.likes_count, 
        d.comments_count, 
        d.likes,
        EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(COALESCE(d.likes, '[]'::jsonb)) AS l
          WHERE l = ${userId}
        ) as "isLiked"
      FROM dietas d
      WHERE d.id_dieta = ${parseInt(id)}
    `;

    if (!dieta) {
      return res.status(404).json({ error: "Dieta não encontrada." });
    }

    res.status(200).json({ data: dieta });
  } catch (error) {
    console.error("Erro ao buscar detalhes da dieta:", error);
    res.status(500).json({ error: "Erro interno do servidor." });
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
      .json({ error: "Nome, descrição, imagem e categoria são obrigatórios." });
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
        error: "Dieta não encontrada ou você não tem permissão para editá-la.",
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
        error: "Dieta não encontrada ou você não tem permissão para excluí-la.",
      });
    }
    res.status(200).json({ message: "Dieta excluída com sucesso!" });
  } catch (error) {
    console.error("Erro ao excluir dieta:", error);
    res.status(500).json({
      error: "Erro interno do servidor ao excluir dieta.",
      details: error.message,
    });
  }
});


// -------------------------------- DIETA SOCIAL ---------------------------- //

app.post("/api/dietas/:id/like", verifyToken, async (req, res) => {
  const userId = String(req.userId);
  const { id } = req.params;

  console.log(`[LIKE DIETA] Iniciando like para dieta ${id} - Usuário ${userId}`);

  try {
    const [dieta] = await sql`SELECT likes FROM dietas WHERE id_dieta = ${parseInt(id)}`;
    
    if (!dieta) {
      console.log(`[LIKE DIETA] Erro: Dieta ${id} não encontrada.`);
      return res.status(404).json({ error: "Dieta não encontrada." });
    }

    let likes = [];
    if (dieta.likes) {
      likes = Array.isArray(dieta.likes) ? dieta.likes.map(String) : [];
    }

    const index = likes.indexOf(userId);
    let newLikes = [];
    let isLiked = false;

    if (index === -1) {
      newLikes = [...likes, userId];
      isLiked = true;
    } else {
      newLikes = likes.filter((uid) => uid !== userId);
      isLiked = false;
    }

    console.log(`[LIKE DIETA] Dieta ${id}: User ${userId} ${isLiked ? 'liked' : 'unliked'}. Total: ${newLikes.length}`);

    const result = await sql`
      UPDATE dietas 
      SET likes = ${newLikes}, 
          likes_count = ${newLikes.length} 
      WHERE id_dieta = ${parseInt(id)}
      RETURNING id_dieta, likes_count
    `;

    console.log(`[LIKE DIETA] Update concluído. Afetado:`, result.length);

    // --- SISTEMA DE NOTIFICAÇÃO ---
    // Busca o autor da dieta para notificar
    const [dietaData] = await sql`SELECT id_us FROM dietas WHERE id_dieta = ${parseInt(id)}`;
    
    // Só notifica se quem curtiu não for o próprio autor
    if (isLiked && dietaData && String(dietaData.id_us) !== userId) {
      await sql`
        INSERT INTO notifications (user_id, type, sender_id, reference_id, message)
        VALUES (${dietaData.id_us}, 'like_diet', ${userId}, ${parseInt(id)}, 'curtiu sua dieta.')
      `;
      console.log(`[LIKE DIETA] Notificação enviada para autor ${dietaData.id_us}`);
    } else if (!isLiked && dietaData) {
      // Remove a notificação se descurtir
      await sql`
        DELETE FROM notifications 
        WHERE user_id = ${dietaData.id_us} 
          AND sender_id = ${userId} 
          AND type = 'like_diet' 
          AND reference_id = ${parseInt(id)}
      `;
    }

    res.json({ success: true, isLiked, likes_count: newLikes.length });
  } catch (error) {
    console.error("[LIKE DIETA] Erro ao curtir dieta:", error);
    res.status(500).json({ error: "Erro interno" });
  }
});

app.post("/api/dietas/:id/comment", verifyToken, async (req, res) => {
  const userId = req.userId;
  const { id } = req.params;
  const { text, comentario, texto } = req.body;
  const commentText = text || comentario || texto;

  console.log(`[POST COMMENT] Dieta: ${id}, Usuario: ${userId}, Texto: ${commentText}`);

  if (!commentText) return res.status(400).json({ error: "Texto do comentário é obrigatório." });

  try {
    const authorIdNum = parseInt(userId);
    const [author] = await sql`SELECT nome, username, avatar_url FROM usuarios WHERE id_us = ${authorIdNum}`;
    
    // Busca comentários existentes com parseInt no ID da dieta
    const [dieta] = await sql`SELECT comments FROM dietas WHERE id_dieta = ${parseInt(id)}`;
    if (!dieta) {
      console.log(`[POST COMMENT] Erro: Dieta ${id} não encontrada.`);
      return res.status(404).json({ error: "Dieta não encontrada." });
    }

    let comments = [];
    if (Array.isArray(dieta.comments)) {
      comments = dieta.comments;
    } else if (typeof dieta.comments === "string") {
      try { comments = JSON.parse(dieta.comments); } catch(e){}
      if (!Array.isArray(comments)) comments = [];
    }

    const newComment = {
      id: uuidv4(),
      user_id: userId,
      username: author?.nome || author?.username || "Usuário",
      photo: author?.avatar_url || "https://gravatar.com/avatar?d=identicon",
      comentario: commentText,
      created_at: new Date().toISOString(),
    };

    const newComments = [...comments, newComment];
    console.log(`[POST COMMENT] Salvando array p/ dieta ${id}:`, newComments.length, "itens");

    const updateResult = await sql`
      UPDATE dietas 
      SET comments = ${sql.json(newComments)}, 
          comments_count = ${newComments.length} 
      WHERE id_dieta = ${parseInt(id)}
      RETURNING id_dieta, id_us, comments_count
    `;

    if (!updateResult[0]) throw new Error("Falha ao atualizar dieta no banco.");

    // --- SISTEMA DE NOTIFICAÇÃO ---
    // Notifica o autor da dieta (quem criou a dieta)
    const authorIdFromDb = updateResult[0].id_us;
    if (authorIdFromDb && String(authorIdFromDb) !== userId) {
      await sql`
        INSERT INTO notifications (user_id, type, sender_id, reference_id, message)
        VALUES (${authorIdFromDb}, 'comment_diet', ${userId}, ${parseInt(id)}, 'comentou na sua dieta.')
      `;
      console.log(`[POST COMMENT] Notificação enviada para autor ${authorIdFromDb}`);
    }

    console.log(`[POST COMMENT] SUCESSO. Dieta ${id} agora tem ${updateResult[0].comments_count} comentários.`);

    res.json({ success: true, data: newComment });
  } catch (error) {
    console.error("[POST COMMENT] Erro:", error);
    res.status(500).json({ error: "Erro interno" });
  }
});

app.get("/api/dietas/:id/comments", verifyToken, async (req, res) => {
  const { id } = req.params;
  try {
    console.log(`[GET COMMENTS] Buscando para dieta: ${id}`);
    const [dieta] = await sql`SELECT comments FROM dietas WHERE id_dieta = ${parseInt(id)}`;
    
    if (!dieta) return res.status(404).json({ error: "Dieta não encontrada." });
    
    let comments = [];
    if (Array.isArray(dieta.comments)) {
      comments = dieta.comments;
    } else if (typeof dieta.comments === "string") {
      try { comments = JSON.parse(dieta.comments); } catch(e){}
      if (!Array.isArray(comments)) comments = [];
    }

    console.log(`[GET COMMENTS] Dieta ${id} tem ${comments.length} comentários.`);
    
    // Retornamos invertido (mais recentes primeiro)
    res.json({ success: true, data: [...comments].reverse() });
  } catch (error) {
    console.error("[GET COMMENTS] Erro:", error);
    res.status(500).json({ error: "Erro interno" });
  }
});

app.delete("/api/dietas/:id/comment/:commentId", verifyToken, async (req, res) => {
  const userId = req.userId;
  const { id, commentId } = req.params;

  try {
    const [dieta] = await sql`SELECT comments, id_us FROM dietas WHERE id_dieta = ${parseInt(id)}`;
    if (!dieta) return res.status(404).json({ error: "Dieta não encontrada." });

    let comments = [];
    if (Array.isArray(dieta.comments)) {
      comments = dieta.comments;
    } else if (typeof dieta.comments === "string") {
      try { comments = JSON.parse(dieta.comments); } catch(e){}
      if (!Array.isArray(comments)) comments = [];
    }

    const commentIndex = comments.findIndex(c => String(c.id) === String(commentId));
    if (commentIndex === -1) {
      return res.status(404).json({ error: "Comentário não encontrado." });
    }

    const comment = comments[commentIndex];
    // Permite excluir se for dono do comentário ou dono do post
    if (String(comment.user_id) !== String(userId) && String(dieta.id_us) !== String(userId)) {
      return res.status(403).json({ error: "Não autorizado." });
    }

    comments.splice(commentIndex, 1);

    await sql`
      UPDATE dietas 
      SET comments = ${sql.json(comments)}, 
          comments_count = ${comments.length} 
      WHERE id_dieta = ${parseInt(id)}
    `;

    res.json({ success: true });
  } catch (error) {
    console.error("[DELETE COMMENT] Erro:", error);
    res.status(500).json({ error: "Erro interno ao deletar." });
  }
});

// -------------------------------- CHAT ---------------------------- //

app.post("/api/chat", verifyToken, async (req, res) => {
  console.log("=== INá CIO DA ROTA POST /api/chat ===");
  console.log("Timestamp:", new Date().toISOString());
  console.log("User ID:", req.userId);

  // Log detalhado dos dados recebidos do frontend
  console.log("--- DADOS RECEBIDOS DO FRONTEND ---");
  console.log("Headers:", JSON.stringify(req.headers, null, 2));
  console.log("Body completo:", JSON.stringify(req.body, null, 2));

  const userId = req.userId; // ID do seu banco de dados (inteiro)
  const { participant2_id } = req.body;

  // Log dos dados extraídos
  console.log("--- DADOS EXTRAá DOS ---");
  console.log("Participant2 ID:", participant2_id);

  // Validação com logs detalhados
  console.log("--- VALIDAÇÃO DOS DADOS ---");
  const validationErrors = [];

  if (!participant2_id) {
    validationErrors.push("Participant2 ID é obrigatório");
    console.log("â Œ ERRO: Participant2 ID não fornecido");
  } else {
    console.log("✅ Participant2 ID válido:", participant2_id);
  }

  if (validationErrors.length > 0) {
    console.log("--- FALHA NA VALIDAÇÃO ---");
    console.log("Erros encontrados:", validationErrors);
    console.log("=== FIM DA ROTA POST /api/chat (ERRO 400) ===");
    return res.status(400).json({
      error: "Dados obrigatórios não fornecidos.",
      details: validationErrors,
    });
  }

  console.log("✅ Todas as validações passaram");

  try {
    // Testar conexão com o banco de dados antes de tentar a consulta
    try {
      await sql`SELECT 1`;
    } catch (dbError) {
      console.error("Erro na conexão com o banco de dados:", dbError);
      return res.status(503).json({
        error: "Serviço de banco de dados temporariamente indisponível.",
        details: dbError.message
      });
    }

    console.log("--- VERIFICANDO SE USUÁRIOS EXISTEM ---");
    console.log("Buscando usuário com ID:", participant2_id);

    // Verificar se o outro usuário existe no seu banco de dados
    const [otherUser] = await sql`
      SELECT id_us FROM usuarios WHERE id_us = ${participant2_id}
    `;

    if (!otherUser) {
      console.log("ERRO: Usuário participante não encontrado no banco de dados");
      console.log("=== FIM DA ROTA POST /api/chat (ERRO 404) ===");
      return res.status(404).json({ error: "Usuário participante não encontrado." });
    }

    console.log("Usuário participante encontrado:", otherUser.id_us);

    // Obter os UUIDs do Supabase Auth para ambos os usuários
    const currentUserMapping = await getUserAuthId(userId);
    const otherUserMapping = await getUserAuthId(participant2_id);

    if (!currentUserMapping || !otherUserMapping) {
      console.log("ERRO: Usuários não encontrados no sistema de autenticação do Supabase");
      return res.status(404).json({
        error: "Usuários não encontrados no sistema de autenticação."
      });
    }

    const currentUserId = currentUserMapping.auth_user_id;
    const otherUserId = otherUserMapping.auth_user_id;

    console.log("✅ UUIDs do Supabase Auth obtidos");
    console.log("Current user UUID:", currentUserId);
    console.log("Other user UUID:", otherUserId);

    // Verificar se já existe um chat entre esses dois usuários no Supabase
    console.log("--- VERIFICANDO SE CHAT Já  EXISTE NO SUPABASE ---");
    const { data: existingChat, error: chatError } = await supabase
      .from('chats')
      .select('id')
      .or(`and(participant1_id.eq.${currentUserId},participant2_id.eq.${otherUserId}),and(participant1_id.eq.${otherUserId},participant2_id.eq.${currentUserId})`)
      .single();

    if (existingChat && !chatError) {
      console.log("✅ Chat já existe com ID:", existingChat.id);
      return res.status(200).json({
        message: "Chat já existente",
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

    console.log("Chat inserido com sucesso no Supabase");
    console.log("--- DADOS DO CHAT CRIADO ---");
    console.log("ID do chat:", newChat.id);
    console.log("Participant1 ID:", newChat.participant1_id);
    console.log("Participant2 ID:", newChat.participant2_id);
    console.log("Data de criação:", newChat.created_at);

    console.log("--- RESPOSTA DE SUCESSO ---");
    console.log("Status: 201 - Created");
    console.log("=== FIM DA ROTA POST /api/chat (SUCESSO) ===");

    res.status(201).json({
      message: "Chat criado com sucesso!",
      chatId: newChat.id,
      data: newChat,
    });
  } catch (error) {
    console.log("--- ERRO DURANTE A EXECUÇÃO ---");
    console.error("ERRO ao criar chat:", error);
    console.log("Tipo do erro:", error.constructor.name);
    console.log("Código do erro:", error.code);
    console.log("Mensagem do erro:", error.message);
    console.log("Stack trace:", error.stack);

    // Verificar se é um erro de conexão com o banco de dados
    if (error.message && (error.message.includes('Tenant or user not found') || error.message.includes('FATAL'))) {
      return res.status(503).json({
        error: "Erro de conexão com o banco de dados. Serviço temporariamente indisponível.",
        details: "O sistema de chat está temporariamente indisponível. Tente novamente mais tarde."
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
    // Testar conexão com o banco de dados antes de tentar a consulta
    try {
      await sql`SELECT 1`;
    } catch (dbError) {
      console.error("Erro na conexão com o banco de dados:", dbError);
      return res.status(503).json({
        error: "Serviço de banco de dados temporariamente indisponível.",
        details: dbError.message
      });
    }

    // Obter o UUID do Supabase Auth para o usuário atual
    const userMapping = await getUserAuthId(userId);
    if (!userMapping) {
      return res.status(404).json({
        error: "Usuário não encontrado no sistema de autenticação."
      });
    }

    const supabaseUserId = userMapping.auth_user_id;

    // Buscar todos os chats em que o usuário participa no Supabase
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
        created_at,
        deleted_at_p1,
        deleted_at_p2
      `)
      .or(`participant1_id.eq.${supabaseUserId},participant2_id.eq.${supabaseUserId}`)
      .not('last_message', 'is', null)
      .order('last_timestamp', { ascending: false });

    if (chatError) {
      console.error("Erro ao buscar chats no Supabase:", chatError);
      return res.status(500).json({
        error: "Erro ao obter chats.",
        details: chatError.message
      });
    }

    // Filtragem Lógica: Esconder chats excluídos individualmente
    const activeChats = chats.filter(chat => {
      const isParticipant1 = chat.participant1_id === supabaseUserId;
      const deletedAt = isParticipant1 ? chat.deleted_at_p1 : chat.deleted_at_p2;

      // Se nunca foi deletado, exibe
      if (!deletedAt) return true;

      // Se foi deletado, mas a última mensagem é mais recente que a exclusão, exibe
      if (chat.last_timestamp && new Date(chat.last_timestamp) > new Date(deletedAt)) {
        return true;
      }

      return false;
    });

    // Mapear os resultados para incluir unread_count apropriado e dados do participante
    const chatsWithDetails = await Promise.all(activeChats.map(async (chat) => {
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

    // Verificar se é um erro de conexão com o banco de dados
    if (error.message && (error.message.includes('Tenant or user not found') || error.message.includes('FATAL'))) {
      return res.status(503).json({
        error: "Erro de conexão com o banco de dados. Serviço temporariamente indisponível.",
        details: "O sistema está temporariamente indisponível. Tente novamente mais tarde."
      });
    }

    res.status(500).json({
      error: "Erro interno do servidor ao obter chats.",
      details: error.message,
    });
  }
});

// Rota para deletar ou atualizar chat removida para simplificação ou movida
app.put("/api/chat/:id_chat", verifyToken, async (req, res) => {

  const userId = req.userId;
  const { id_chat } = req.params;
  const { last_message, last_timestamp } = req.body;

  try {
    // Obter o UUID do Supabase para o usuário atual
    const userMapping = await getUserAuthId(userId);
    if (!userMapping) {
      return res.status(404).json({
        error: "Usuário não encontrado no sistema de autenticação."
      });
    }
    const supabaseUserId = userMapping.auth_user_id;

    // Verificar se o usuário é parte do chat usando UUIDs
    const [chat] = await sql`
      SELECT participant1_id, participant2_id
      FROM chats
      WHERE id = ${id_chat}
    `;

    if (!chat || (chat.participant1_id !== supabaseUserId && chat.participant2_id !== supabaseUserId)) {
      return res.status(403).json({
        error: "Você não tem permissão para atualizar este chat.",
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
        error: "Chat não encontrado ou você não tem permissão para editá-lo.",
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
    // Obter o UUID do Supabase para o usuário atual
    const userMapping = await getUserAuthId(userId);
    if (!userMapping) {
      return res.status(404).json({
        error: "Usuário não encontrado no sistema de autenticação."
      });
    }
    const supabaseUserId = userMapping.auth_user_id;

    // Verificar se o usuário é parte do chat usando os UUIDs
    const [chat] = await sql`
      SELECT participant1_id, participant2_id
      FROM chats
      WHERE id = ${id_chat}
    `;

    if (!chat || (chat.participant1_id !== supabaseUserId && chat.participant2_id !== supabaseUserId)) {
      return res.status(403).json({
        error: "Você não tem permissão para excluir este chat.",
      });
    }

    // Identificar qual participante está deletando e atualizar a coluna correspondente
    const isParticipant1 = chat.participant1_id === supabaseUserId;
    const updateColumn = isParticipant1 ? 'deleted_at_p1' : 'deleted_at_p2';

    const [updatedChat] = await sql`
      UPDATE chats
      SET ${sql(updateColumn)} = NOW()
      WHERE id = ${id_chat}
      RETURNING *;
    `;

    if (!updatedChat) {
      return res.status(404).json({
        error: "Chat não encontrado.",
      });
    }
    res.status(200).json({ message: "Chat excluído da sua lista com sucesso!" });
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
    return res.status(400).json({ error: "Texto ou imagem é obrigatório." });
  }

  try {
    // Obter UUID do Supabase diretamente da tabela usuarios
    const [user] = await sql`SELECT auth_user_id FROM usuarios WHERE id_us = ${userId}`;
    if (!user || !user.auth_user_id) {
      return res.status(404).json({ error: "ID de autenticação não encontrado para este usuário." });
    }
    const supabaseUserId = user.auth_user_id;

    // Verificar se o usuário faz parte do chat
    const { data: chat, error: chatErr } = await supabase
      .from('chats')
      .select('id, participant1_id, participant2_id')
      .eq('id', id_chat)
      .single();

    if (chatErr || !chat) {
      return res.status(404).json({ error: "Chat não encontrado." });
    }

    if (chat.participant1_id !== supabaseUserId && chat.participant2_id !== supabaseUserId) {
      return res.status(403).json({ error: "Sem permissão para este chat." });
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

    // Atualizar meta do chat e restaurar visibilidade para ambos
    if (chat.participant1_id === supabaseUserId) {
      await sql`
        UPDATE chats 
        SET 
          unread_count_p1 = unread_count_p1 + 1,
          last_message = ${text || 'Imagem'},
          last_timestamp = NOW(),
          last_sender_id = ${supabaseUserId},
          deleted_at_p1 = NULL,
          deleted_at_p2 = NULL
        WHERE id = ${id_chat}
      `;
    } else {
      await sql`
        UPDATE chats 
        SET 
          unread_count_p2 = unread_count_p2 + 1,
          last_message = ${text || 'Imagem'},
          last_timestamp = NOW(),
          last_sender_id = ${supabaseUserId},
          deleted_at_p1 = NULL,
          deleted_at_p2 = NULL
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
      return res.status(404).json({ error: "ID de autenticação não encontrado." });
    }
    const supabaseUserId = user.auth_user_id;

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

  // Log dos dados extraídos
  console.log("--- DADOS EXTRAá DOS ---");
  console.log("Nome:", nome);
  console.log("Descrição:", descricao);
  console.log("Image URL:", imageurl);
  console.log("Categoria:", categoria);
  console.log("Calorias:", calorias);
  console.log("Tempo de preparo:", tempo_preparo);
  console.log("Gordura:", gordura);
  console.log("Proteína:", proteina);
  console.log("Carboidratos:", carboidratos);

  // Validação com logs detalhados
  console.log("--- VALIDAÇÃO DOS DADOS ---");
  const validationErrors = [];

  if (!nome) {
    validationErrors.push("Nome é obrigatório");
    console.log("â Œ ERRO: Nome não fornecido");
  } else {
    console.log("✅ Nome válido:", nome);
  }

  if (!descricao) {
    validationErrors.push("Descrição é obrigatória");
    console.log("â Œ ERRO: Descrição não fornecida");
  } else {
    console.log("✅ Descrição válida:", descricao.substring(0, 50) + "...");
  }

  if (!imageurl) {
    validationErrors.push("URL da imagem é obrigatória");
    console.log("â Œ ERRO: URL da imagem não fornecida");
  } else {
    console.log("✅ URL da imagem válida:", imageurl);
  }

  if (!categoria) {
    validationErrors.push("Categoria é obrigatória");
    console.log("â Œ ERRO: Categoria não fornecida");
  } else {
    console.log("✅ Categoria válida:", categoria);
  }

  if (validationErrors.length > 0) {
    console.log("--- FALHA NA VALIDAÇÃO ---");
    console.log("Erros encontrados:", validationErrors);
    console.log("=== FIM DA ROTA POST /api/dietas (ERRO 400) ===");
    return res.status(400).json({
      error: "Dados obrigatórios não fornecidos.",
      details: validationErrors,
    });
  }

  console.log("✅ Todas as validações passaram");

  try {
    console.log("--- BUSCANDO DADOS DO AUTOR ---");
    console.log("Buscando usuário com ID:", userId);

    const [author] =
      await sql`SELECT nome, username, email, avatar_url FROM usuarios WHERE id_us = ${userId}`;

    if (!author) {
      console.log("ERRO: Usuário autor não encontrado no banco de dados");
      console.log("=== FIM DA ROTA POST /api/dietas (ERRO 404) ===");
      return res.status(404).json({ error: "Usuário autor não encontrado." });
    }

    console.log("Autor encontrado:", {
      nome: author.nome,
      username: author.username,
      email: author.email,
    });

    const authorName = author.nome || author.username || null;
    const authorAvatarUrl = author.avatar_url || getGravatarUrl(author.email);

    console.log("--- PREPARANDO DADOS PARA INSERÇÃO ---");
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

    console.log("✅ Dieta inserida com sucesso no banco de dados");
    console.log("--- DADOS DA DIETA CRIADA ---");
    console.log("ID da dieta:", newDieta.id_dieta);
    console.log("Nome:", newDieta.nome);
    console.log("Categoria:", newDieta.categoria);
    console.log("Data de criação:", newDieta.createdat);

    console.log("--- RESPOSTA DE SUCESSO ---");
    console.log("Status: 201 - Created");
    console.log("=== FIM DA ROTA POST /api/dietas (SUCESSO) ===");

    res.status(201).json({
      message: "Dieta criada com sucesso!",
      data: newDieta,
    });
  } catch (error) {
    console.log("--- ERRO DURANTE A EXECUÇÃO ---");
    console.error("â Œ ERRO ao criar dieta:", error);
    console.log("Tipo do erro:", error.constructor.name);
    console.log("Código do erro:", error.code);
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
    let query = sql`SELECT id_us, nome, descricao, imageurl, calorias, tempo_preparo, gordura, proteina, carboidratos, nome_autor, avatar_autor_url, createdat, updatedat, categoria, id_dieta, likes_count, comments_count, likes FROM dietas WHERE id_us = ${userId}`;

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
      .json({ error: "Nome, descrição, imagem e categoria são obrigatórios." });
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
        error: "Dieta não encontrada ou você não tem permissão para editá-la.",
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
        error: "Dieta não encontrada ou você não tem permissão para excluí-la.",
      });
    }
    res.status(200).json({ message: "Dieta excluída com sucesso!" });
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
        telefone_contato,
        EXISTS (
          SELECT 1 FROM community_members cm
          WHERE cm.id_comunidade = comunidades.id_comunidade AND cm.id_us = ${userId}
        ) as is_member
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
        telefone_contato,
        EXISTS (
          SELECT 1 FROM community_members cm 
          WHERE cm.id_comunidade = comunidades.id_comunidade AND cm.id_us = ${req.userId}
        ) as is_member
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
    return res.status(400).json({ error: "Nome e categoria são obrigatórios." });
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

// POST: Entrar na comunidade (com controle de plano)
app.post("/api/comunidades/:id_comunidade/entrar", verifyToken, checkFreePlanLimit('comunidades'), async (req, res) => {

  const { id_comunidade } = req.params;
  const userId = req.userId;

  try {
    // Verificar se o usuário já é membro
    const [existingMember] = await sql`
      SELECT id FROM community_members
      WHERE id_comunidade = ${id_comunidade} AND id_us = ${userId}
    `;

    if (existingMember) {
      return res.status(409).json({ error: "Você já é membro desta comunidade." });
    }

    // Registrar membro
    await sql`
      INSERT INTO community_members (id_comunidade, id_us) VALUES (${id_comunidade}, ${userId})
    `;

    // Incrementar o contador de participantes
    const [updated] = await sql`
      UPDATE comunidades
      SET participantes = (CAST(COALESCE(NULLIF(participantes, ''), '0') AS INTEGER) + 1)::TEXT, updatedat = NOW()
      WHERE id_comunidade = ${id_comunidade}
      RETURNING *;
    `;

    if (!updated) {
      return res.status(404).json({ error: "Comunidade não encontrada." });
    }

    // Incrementar o contador mensal do usuário (só para free)
    await sql`
      UPDATE usuarios
      SET community_joins_month = COALESCE(community_joins_month, 0) + 1,
          community_joins_month_reset = CASE
            WHEN community_joins_month_reset IS NULL THEN NOW()
            ELSE community_joins_month_reset
          END
      WHERE id_us = ${userId}
    `;

    res.status(200).json({ message: "Você entrou na comunidade!", data: updated });
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
        error: "Comunidade não encontrada ou você não tem permissão para excluí-la.",
      });
    }
    res.status(200).json({ message: "Comunidade excluída com sucesso!" });
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
            a.horarios_funcionamento,
            a.ativo,
            a.fotos,
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
            horarios_funcionamento,
            ativo,
            fotos,
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
  console.log("=== INá CIO DA ROTA GET /api/dados/calories ===");
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

    console.log("Buscando dados de calorias de", startDate, "até", endDate);

    // Busca os dados de calorias do usuário
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

    console.log(`✅ Encontrados ${caloriesData.length} registros de calorias`);

    // Agrupa dados se necessário
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

    // Calcula a média de calorias por período
    const processedData = Object.values(groupedData).map((item) => ({
      date: item.date,
      calories: Math.round(item.calories / item.count),
      timestamp: item.timestamp,
    }));

    // Se não houver dados, gera dados mockados
    const data =
      processedData.length > 0
        ? processedData
        : generateMockCaloriesData(timeframe);

    // Calcula estatísticas
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
    console.log("Total de pontos no gráfico:", data.length);
    console.log("=== FIM DA ROTA GET /api/dados/calories (SUCESSO) ===");

    res.status(200).json(response);
  } catch (error) {
    console.error("â Œ Erro ao buscar dados de calorias:", error);
    console.log("=== FIM DA ROTA GET /api/dados/calories (ERRO 500) ===");
    res.status(500).json({
      error: "Erro interno do servidor ao buscar dados de calorias.",
      details: error.message,
    });
  }
});

// POST: Salvar dados de calorias
app.post("/api/dados/calories", verifyToken, async (req, res) => {
  console.log("=== INá CIO DA ROTA POST /api/dados/calories ===");
  console.log("Timestamp:", new Date().toISOString());
  console.log("User ID:", req.userId);
  console.log("Body:", req.body);

  const userId = req.userId;
  const { calories, timestamp } = req.body;

  if (!calories) {
    console.log("â Œ Erro: Calorias não fornecidas");
    return res.status(400).json({ error: "Calorias são obrigatórias." });
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

    console.log("✅ Registro de calorias criado com sucesso");
    console.log("ID do registro:", newRecord.id_dado);
    console.log("=== FIM DA ROTA POST /api/dados/calories (SUCESSO) ===");

    res.status(201).json({
      message: "Dados de calorias salvos com sucesso!",
      data: newRecord,
    });
  } catch (error) {
    console.error("â Œ Erro ao salvar dados de calorias:", error);
    console.log("=== FIM DA ROTA POST /api/dados/calories (ERRO 500) ===");
    res.status(500).json({
      error: "Erro interno do servidor ao salvar dados de calorias.",
      details: error.message,
    });
  }
});

// -------------------------------- WEAR OS DEVICES ---------------------------- //

// POST: Registrar automaticamente um dispositivo Wear OS ✅
app.post("/api/wearos/register", verifyToken, async (req, res) => {
  console.log("=== INá CIO DA ROTA POST /api/wearos/register-device ===");
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
    console.log("â Œ Erro: Nome e modelo do dispositivo são obrigatórios");
    return res.status(400).json({
      error: "Nome e modelo do dispositivo são obrigatórios."
    });
  }

  try {
    // Verificar se já existe um dispositivo com este modelo para o usuário
    const existingDevice = await sql`
      SELECT id_disp FROM dispositivos
      WHERE id_us = ${userId}
      AND modelo = ${deviceModel}
      AND tipo = ${deviceType}
    `;

    if (existingDevice.length > 0) {
      console.log("Dispositivo já registrado para o usuário:", existingDevice[0].id_disp);
      return res.status(200).json({
        message: "Dispositivo já estava registrado",
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

    console.log("✅ Dispositivo registrado com sucesso:", newDevice.id_disp);
    console.log("=== FIM DA ROTA POST /api/wearos/register-device ===");

    res.status(201).json({
      message: "Dispositivo Wear OS registrado com sucesso!",
      deviceId: newDevice.id_disp,
      device: newDevice
    });
  } catch (error) {
    console.error("â Œ Erro ao registrar dispositivo Wear OS:", error);
    console.log("=== FIM DA ROTA POST /api/wearos/register-device (ERRO) ===");
    res.status(500).json({
      error: "Erro interno do servidor ao registrar dispositivo.",
      details: error.message
    });
  }
});

// GET: Listar dispositivos Wear OS do usuário ✅
app.get("/api/wearos/devices", verifyToken, async (req, res) => {
  console.log("=== Início da ROTA GET /api/wearos/devices ===");
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

    console.log(`✅ Encontrados ${devices.length} dispositivos Wear OS`);
    console.log("=== FIM DA ROTA GET /api/wearos/devices ===");

    res.status(200).json({
      message: "Dispositivos Wear OS listados com sucesso!",
      devices: devices,
      count: devices.length
    });
  } catch (error) {
    console.error("â Œ Erro ao listar dispositivos Wear OS:", error);
    console.log("=== FIM DA ROTA GET /api/wearos/devices (ERRO) ===");
    res.status(500).json({
      error: "Erro interno do servidor ao listar dispositivos.",
      details: error.message
    });
  }
});

// GET: Verificar se o usuário tem dispositivos Wear OS registrados ✅
app.get("/api/wearos/devicesON", verifyToken, async (req, res) => {
  console.log("=== Início da ROTA GET /api/wearos/has-devices ===");
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

    console.log(`Usuário ${userId} tem ${result[0].device_count} dispositivos Wear OS`);
    console.log("=== FIM DA ROTA GET /api/wearos/has-devices ===");

    res.status(200).json({
      hasDevices: hasDevices,
      deviceCount: parseInt(result[0].device_count)
    });
  } catch (error) {
    console.error("â Œ Erro ao verificar dispositivos Wear OS:", error);
    console.log("=== FIM DA ROTA GET /api/wearos/has-devices (ERRO) ===");
    res.status(500).json({
      error: "Erro interno do servidor ao verificar dispositivos.",
      details: error.message
    });
  }
});

// POST: Registrar dados de saúde do Wear OS
app.post("/api/wearos/health", verifyToken, async (req, res) => {
  console.log("=== INá CIO DA ROTA POST /api/wearos/health-data ===");
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
    console.log("â Œ Erro: ID do dispositivo é obrigatório");
    return res.status(400).json({
      error: "ID do dispositivo é obrigatório."
    });
  }

  // Verificar se o dispositivo pertence ao usuário
  const deviceCheck = await sql`
    SELECT id_disp FROM dispositivos
    WHERE id_disp = ${deviceId}
    AND id_us = ${userId}
  `;

  if (deviceCheck.length === 0) {
    console.log("Erro: Dispositivo não encontrado ou não pertence ao usuário");
    return res.status(404).json({
      error: "Dispositivo não encontrado ou não pertence ao usuário."
    });
  }

  try {
    const healthRecords = [];

    // Registrar dados de frequência cardíaca (usando tabela healthkit)
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

    // Registrar dados de pressão arterial (usando tabela healthkit)
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

    // Registrar dados de oxigênio (usando tabela healthkit)
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

    console.log(`✅ ${healthRecords.length} registros de saúde criados para o dispositivo ${deviceId}`);
    console.log("=== FIM DA ROTA POST /api/wearos/health-data ===");

    res.status(201).json({
      message: "Dados de saúde registrados com sucesso!",
      records: healthRecords,
      count: healthRecords.length
    });
  } catch (error) {
    console.error("â Œ Erro ao registrar dados de saúde:", error);
    console.log("=== FIM DA ROTA POST /api/wearos/health-data (ERRO) ===");
    res.status(500).json({
      error: "Erro interno do servidor ao registrar dados de saúde.",
      details: error.message
    });
  }
});

// GET: Obter dados de saúde mais recentes de dispositivos Wear OS ✅
app.get("/api/wearos/health", verifyToken, async (req, res) => {
  console.log("=== INá CIO DA ROTA GET /api/wearos/latest-health-data ===");
  console.log("User ID:", req.userId);

  const userId = req.userId;

  try {
    // Primeiro, obter os dispositivos Wear OS do usuário
    const devices = await sql`
      SELECT id_disp FROM dispositivos
      WHERE id_us = ${userId}
      AND tipo = 'Wear OS'
      AND status = 'ativo';
    `;

    if (devices.length === 0) {
      console.log("Nenhum dispositivo Wear OS encontrado para o usuário");
      return res.status(200).json({
        message: "Nenhum dispositivo Wear OS registrado",
        heartRate: null,
        pressure: null,
        oxygen: null,
        devices: []
      });
    }

    // Obter os dados de saúde mais recentes para cada tipo da tabela healthkit
    const [heartRateData, pressureData, oxygenData] = await Promise.all([
      // Frequência cardíaca
      sql`
        SELECT h.valor, h.createdat, d.nome as device_name
        FROM healthkit h
        JOIN dispositivos d ON h.id_disp = d.id_disp
        WHERE h.id_disp IN (${sql.join(devices.map(d => d.id_disp), ',')})
          AND h.tipo_dado = 'heart_rate'
        ORDER BY h.createdat DESC
        LIMIT 1;
      `,

      // Pressão arterial
      sql`
        SELECT h.valor, h.createdat, d.nome as device_name
        FROM healthkit h
        JOIN dispositivos d ON h.id_disp = d.id_disp
        WHERE h.id_disp IN (${sql.join(devices.map(d => d.id_disp), ',')})
          AND h.tipo_dado = 'blood_pressure'
        ORDER BY h.createdat DESC
        LIMIT 1;
      `,

      // Oxigênio (SpO2)
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
      message: "Dados de saúde mais recentes recuperados",
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

    console.log("✅ Dados de saúde recuperados com sucesso");
    console.log("Heart Rate:", result.heartRate);
    console.log("Pressure:", result.pressure);
    console.log("Oxygen:", result.oxygen);
    console.log("=== FIM DA ROTA GET /api/wearos/latest-health-data ===");

    res.status(200).json(result);
  } catch (error) {
    console.error("â Œ Erro ao obter dados de saúde:", error);
    console.log("=== FIM DA ROTA GET /api/wearos/latest-health-data (ERRO) ===");
    res.status(500).json({
      error: "Erro interno do servidor ao obter dados de saúde.",
      details: error.message
    });
  }
});

// GET: Obter histórico de dados de saúde do Wear OS ✅
app.get("/api/wearos/health-history", verifyToken, async (req, res) => {
  console.log("=== INá CIO DA ROTA GET /api/wearos/health-history ===");
  console.log("User ID:", req.userId);
  const { timeframe = "1d", dataType = "all" } = req.query;

  const userId = req.userId;

  try {
    // Obter dispositivos Wear OS do usuário
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

    console.log(`✅ Encontrados ${healthHistory.length} registros de saúde`);
    console.log("Timeframe:", timeframe, "DataType:", dataType);
    console.log("=== FIM DA ROTA GET /api/wearos/health-history ===");

    res.status(200).json({
      message: "Histórico de dados de saúde recuperado",
      data: healthHistory,
      totalRecords: healthHistory.length,
      timeframe: timeframe,
      dataType: dataType
    });
  } catch (error) {
    console.error("â Œ Erro ao obter histórico de saúde:", error);
    console.log("=== FIM DA ROTA GET /api/wearos/health-history (ERRO) ===");
    res.status(500).json({
      error: "Erro interno do servidor ao obter histórico de saúde.",
      details: error.message
    });
  }
});

// PUT: Atualizar status do dispositivo Wear OS
app.put("/api/wearos/status/:deviceId", verifyToken, async (req, res) => {
  console.log("=== INá CIO DA ROTA PUT /api/wearos/device-status/:deviceId ===");
  console.log("User ID:", req.userId);
  console.log("Device ID:", req.params.deviceId);
  console.log("Body:", req.body);

  const userId = req.userId;
  const deviceId = req.params.deviceId;
  const { status } = req.body;

  if (!status) {
    return res.status(400).json({
      error: "Status é obrigatório."
    });
  }

  if (!['ativo', 'inativo', 'conectando', 'desconectado'].includes(status)) {
    return res.status(400).json({
      error: "Status inválido. Use: ativo, inativo, conectando, desconectado"
    });
  }

  try {
    // Verificar se o dispositivo pertence ao usuário
    const deviceCheck = await sql`
      SELECT id_disp FROM dispositivos
      WHERE id_disp = ${deviceId}
      AND id_us = ${userId}
    `;

    if (deviceCheck.length === 0) {
      return res.status(404).json({
        error: "Dispositivo não encontrado ou não pertence ao usuário."
      });
    }

    const [updatedDevice] = await sql`
      UPDATE dispositivos
      SET status = ${status}, updatedat = ${new Date()}
      WHERE id_disp = ${deviceId}
      RETURNING *;
    `;

    console.log(`✅ Status do dispositivo ${deviceId} atualizado para: ${status}`);
    console.log("=== FIM DA ROTA PUT /api/wearos/device-status/:deviceId ===");

    res.status(200).json({
      message: "Status do dispositivo atualizado com sucesso!",
      device: updatedDevice
    });
  } catch (error) {
    console.error("â Œ Erro ao atualizar status do dispositivo:", error);
    console.log("=== FIM DA ROTA PUT /api/wearos/device-status/:deviceId (ERRO) ===");
    res.status(500).json({
      error: "Erro interno do servidor ao atualizar status do dispositivo.",
      details: error.message
    });
  }
});

// DELETE: Remover dispositivo Wear OS
app.delete("/api/wearos/device/:deviceId", verifyToken, async (req, res) => {
  console.log("=== INá CIO DA ROTA DELETE /api/wearos/device/:deviceId ===");
  console.log("User ID:", req.userId);
  console.log("Device ID:", req.params.deviceId);

  const userId = req.userId;
  const deviceId = req.params.deviceId;

  try {
    // Verificar se o dispositivo pertence ao usuário
    const deviceCheck = await sql`
      SELECT id_disp FROM dispositivos
      WHERE id_disp = ${deviceId}
      AND id_us = ${userId}
    `;

    if (deviceCheck.length === 0) {
      return res.status(404).json({
        error: "Dispositivo não encontrado ou não pertence ao usuário."
      });
    }

    // Remover registros de saúde associados
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

    console.log(`✅ Dispositivo ${deviceId} e dados associados removidos`);
    console.log("=== FIM DA ROTA DELETE /api/wearos/device/:deviceId ===");

    res.status(200).json({
      message: "Dispositivo e dados de saúde associados removidos com sucesso!",
      device: deletedDevice
    });
  } catch (error) {
    console.error("❌ Erro ao remover dispositivo:", error);
    console.log("=== FIM DA ROTA DELETE /api/wearos/device/:deviceId (ERRO) ===");
    res.status(500).json({
      error: "Erro interno do servidor ao remover dispositivo.",
      details: error.message
    });
  }
});

// GET: Listar agendamentos do usuário (como cliente ou trainer)
app.get("/api/appointments", verifyToken, async (req, res) => {
  const userId = req.userId;
  const { role = "client" } = req.query; // 'client' ou 'trainer'

  try {
    const [{ exists }] = await sql`SELECT to_regclass('public.agendamentos') IS NOT NULL AS exists`;
    if (!exists) {
      return res.status(501).json({ error: "Sistema de agendamentos não instalado." });
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

// GET: Buscar agendamentos de um trainer em uma data específica
app.get("/api/appointments/trainer/:trainerId", async (req, res) => {
  const trainerId = req.params.trainerId;
  const { date } = req.query; // YYYY-MM-DD

  try {
    if (!trainerId || isNaN(parseInt(trainerId, 10))) {
      return res.status(400).json({ error: "ID do trainer inválido." });
    }

    const [{ exists }] = await sql`SELECT to_regclass('public.agendamentos') IS NOT NULL AS exists`;
    if (!exists) {
      return res.status(501).json({ error: "Sistema de agendamentos não instalado." });
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
      return res.status(501).json({ error: "Sistema de agendamentos não instalado." });
    }

    // Buscar o agendamento
    const [appointment] = await sql`
      SELECT * FROM agendamentos WHERE id_agendamento = ${appointmentId}
    `;

    if (!appointment) {
      return res.status(404).json({ error: "Agendamento não encontrado." });
    }

    // Verificar permissão (trainer ou cliente do agendamento)
    if (appointment.id_trainer !== userId && appointment.id_usuario !== userId) {
      return res.status(403).json({ error: "Sem permissão para atualizar este agendamento." });
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
      return res.status(501).json({ error: "Sistema de agendamentos não instalado." });
    }

    const [appointment] = await sql`
      SELECT * FROM agendamentos WHERE id_agendamento = ${appointmentId}
    `;

    if (!appointment) {
      return res.status(404).json({ error: "Agendamento não encontrado." });
    }

    // Verificar permissão
    if (appointment.id_trainer !== userId && appointment.id_usuario !== userId) {
      return res.status(403).json({ error: "Sem permissão para cancelar este agendamento." });
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

// ==================== PERSONAL TRAINER DASHBOARD ==================== //

app.get("/api/personal/dashboard-stats", verifyToken, async (req, res) => {
  const userId = req.userId;

  try {
    // Verificar se é personal/trainer
    const [trainerCheck] = await sql`
      SELECT role, nome, avatar_url, plan FROM usuarios WHERE id_us = ${userId}
    `;
    const validRoles = ['personal', 'trainer', 'pj', 'admin'];
    if (!trainerCheck || !validRoles.includes((trainerCheck.role || '').toLowerCase())) {
      return res.status(403).json({ error: "Acesso negado. Apenas personais podem acessar esta rota." });
    }

    const [{ exists }] = await sql`SELECT to_regclass('public.agendamentos') IS NOT NULL AS exists`;
    if (!exists) {
      return res.json({
        success: true,
        kpis: { totalMonth: 0, pending: 0, confirmed: 0, clients: 0 },
        pending: [],
        upcoming: [],
        clients: [],
      });
    }

    const { tab = 'month', plan = 'all', status = 'all' } = req.query;

    const now = new Date();
    let startDate;
    if (tab === 'day') startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    else if (tab === 'year') startDate = new Date(now.getFullYear(), 0, 1);
    else startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    
    const startIso = startDate.toISOString().split('T')[0];
    const today = now.toISOString().split('T')[0];

    // Query Base para KPIs e Listas
    let kpiQuery = sql`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'pendente') AS total_pending,
        COUNT(*) FILTER (WHERE status = 'confirmado' AND data_agendamento >= ${today}) AS total_upcoming,
        COUNT(DISTINCT id_usuario) AS total_clients
      FROM agendamentos
      WHERE id_trainer = ${userId} AND data_agendamento >= ${startIso}
    `;

    // Aplicar filtros de plano se necessário (isso exigiria join com usuários)
    // Para simplificar agora, focaremos no funcionamento dos sheets

    const [stats] = await kpiQuery;

    // Faturamento Real (Soma dos valores lidos dos comprovantes)
    const [revenueStats] = await sql`
      SELECT 
        COALESCE(SUM(valor_recebido), 0) as current_revenue
      FROM agendamentos
      WHERE id_trainer = ${userId} AND data_agendamento >= ${startIso} AND pagamento_verificado = TRUE
    `;

    // Lista Completa de Agendamentos (para o sheet de Agendamentos)
    const allAppointments = await sql`
      SELECT 
        a.id_agendamento, a.data_agendamento, a.hora_inicio, a.hora_fim, a.status, a.notas,
        u.nome as user_name, u.avatar_url as user_avatar, u.email as user_email
      FROM agendamentos a
      JOIN usuarios u ON a.id_usuario = u.id_us
      WHERE a.id_trainer = ${userId} AND a.data_agendamento >= ${startIso}
      ORDER BY a.data_agendamento DESC, a.hora_inicio DESC
    `;

    // Dados para o gráfico
    const chartDataResult = await sql`
      SELECT 
        TO_CHAR(d, 'DD/MM') as label,
        COALESCE(count(a.id_agendamento), 0)::int as total
      FROM generate_series(CURRENT_DATE - INTERVAL '6 days', CURRENT_DATE, '1 day') d
      LEFT JOIN agendamentos a ON DATE(a.data_agendamento) = DATE(d) AND a.id_trainer = ${userId}
      GROUP BY d
      ORDER BY d ASC
    `;

    const chartData = chartDataResult.map(row => ({
      label: row.label,
      total: parseInt(row.total || 0)
    }));

    // Distribuição de status
    const statusDistribution = await sql`
      SELECT status as label, COUNT(*) as count
      FROM agendamentos
      WHERE id_trainer = ${userId} AND data_agendamento >= ${startIso}
      GROUP BY status
    `;

    const statusColors = {
      'confirmado': '#10B981',
      'pendente': '#F59E0B',
      'cancelado': '#EF4444',
      'concluido': '#6366F1'
    };

    const formattedDist = statusDistribution.map(item => ({
      label: item.label.charAt(0).toUpperCase() + item.label.slice(1),
      count: parseInt(item.count),
      color: statusColors[item.label] || '#94A3B8'
    }));

    // Agendamentos pendentes
    const pendingAppointments = await sql`
      SELECT
        a.id_agendamento, a.data_agendamento, a.hora_inicio, a.hora_fim, a.notas, a.created_at, a.pagamento_verificado,
        u.nome AS user_name, u.avatar_url AS user_avatar, u.email AS user_email
      FROM agendamentos a
      JOIN usuarios u ON a.id_usuario = u.id_us
      WHERE a.id_trainer = ${userId} AND a.status = 'pendente'
      ORDER BY a.created_at DESC
    `;

    // Lista de clientes únicos detalhada
    const clientsData = await sql`
      SELECT 
        u.id_us, u.nome, u.avatar_url, u.email,
        MAX(a.data_agendamento) as last_appointment,
        COUNT(a.id_agendamento) as total_appointments
      FROM agendamentos a
      JOIN usuarios u ON a.id_usuario = u.id_us
      WHERE a.id_trainer = ${userId}
      GROUP BY u.id_us, u.nome, u.avatar_url, u.email
      ORDER BY last_appointment DESC
    `;

    // List of clients this period
    const clientsThisPeriod = await sql`
      SELECT DISTINCT id_usuario 
      FROM agendamentos 
      WHERE id_trainer = ${userId} 
      AND data_agendamento >= ${startIso} 
      AND status IN ('confirmado', 'concluido')
    `;

    const activeUserIds = clientsThisPeriod.map(c => c.id_usuario);
    let retentionRate = 0;
    let returningCount = 0;

    if (activeUserIds.length > 0) {
      const returningClientsQuery = await sql`
        SELECT COUNT(DISTINCT id_usuario) as count
        FROM agendamentos
        WHERE id_trainer = ${userId}
        AND id_usuario IN (${activeUserIds})
        AND data_agendamento < ${startIso}
      `;
      returningCount = parseInt(returningClientsQuery[0].count);
      retentionRate = Math.round((returningCount / activeUserIds.length) * 100);
    }

    // Buscando Avaliações (Reviews)
    let reviews = [];
    try {
      reviews = await sql`
        SELECT 
          av.id_avaliacao as id,
          av.nota_profissional as "ratingProfessional",
          av.nota_treino as "ratingTraining",
          av.comentario as comment,
          av.created_at,
          u.nome as user_name,
          u.avatar_url as user_avatar,
          a.data_agendamento as appointment_date,
          a.hora_inicio as appointment_time
        FROM avaliacoes_treinos av
        LEFT JOIN usuarios u ON av.id_autor::text = u.id_us::text
        LEFT JOIN agendamentos a ON av.id_agendamento = a.id_agendamento
        WHERE av.id_destino::text = ${userId.toString()}
        ORDER BY av.created_at DESC
      `;
    } catch (err) {
      console.error("Erro ao buscar avaliações (pode ser problema na tabela):", err.message);
    }

    // Buscando Agendamentos com Pagamento Verificado (Sucesso/Histórico)
    const receiptHistory = await sql`
      SELECT 
        a.id_agendamento, a.data_agendamento, a.hora_inicio, a.status,
        a.valor_recebido, cp.arquivo_url as receipt_url,
        u.nome as user_name, u.avatar_url as user_avatar
      FROM agendamentos a
      JOIN usuarios u ON a.id_usuario = u.id_us
      JOIN comprovantes_pagamentos cp ON a.id_agendamento = cp.id_agendamento
      WHERE a.id_trainer = ${userId} 
        AND a.pagamento_verificado = TRUE
      ORDER BY a.data_agendamento DESC
      LIMIT 20
    `;

    res.json({
      success: true,
      trainer: {
        nome: trainerCheck.nome,
        avatar_url: trainerCheck.avatar_url,
        plan: trainerCheck.plan,
      },
      retention: {
        rate: retentionRate,
        count: returningCount,
        total: activeUserIds.length
      },
      kpis: {
        totalMonth: parseInt(stats.total || '0'),
        pending: parseInt(stats.total_pending || '0'),
        upcoming: parseInt(stats.total_upcoming || '0'),
        clients: parseInt(stats.total_clients || '0'),
        revenue: parseInt(revenueStats.current_revenue || '0')
      },
      revenue: {
        current: parseInt(revenueStats.current_revenue || '0'),
        growth: "+12%"
      },
      chartData,
      statusDistribution: formattedDist,
      appointments: allAppointments,
      pending: pendingAppointments,
      clients: clientsData,
      reviews: reviews,
      receiptHistory: receiptHistory,
    });
  } catch (err) {
    console.error('[personal/dashboard-stats]', err);
    res.status(500).json({ error: "Erro ao carregar dashboard." });
  }
});

// Endpoint de inicialização - criar tabelas de agendamentos se não existirem
app.post("/api/init/agendamentos", async (req, res) => {
  try {
    console.log("[POST /init/agendamentos] Inicializando tabelas de agendamentos...");
    const fs = require("fs");
    const schema = fs.readFileSync("./agendamentos-schema.sql", "utf-8");
    const statements = schema.split(";").filter(s => s.trim());

    // Executar cada instrução separadamente, ignorando erros de dependência
    for (const statement of statements) {
      if (statement.trim()) {
        try {
          await sql.unsafe(statement);
          console.log(`âœ“ Executado: ${statement.substring(0, 50)}...`);
        } catch (stmtErr) {
          console.log(`⚠ Pulo instrução (pode ser dependência): ${stmtErr.message}`);
          console.log(`  Instrução: ${statement.trim()}`);
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

// POST: Criar nova comunidade (Admin)
app.post("/api/admin/communities", verifyToken, upload.single('image'), async (req, res) => {
  const userId = req.userId;
  let { 
    nome, descricao, imageurl, max_participantes, categoria, 
    tipo_comunidade, duracao, calorias, data_evento, faixa_etaria, 
    premiacao, local_inicio, local_fim, telefone_contato 
  } = req.body;

  try {
    const [adminCheck] = await sql`SELECT role FROM usuarios WHERE id_us = ${userId}`;
    if (!adminCheck || adminCheck.role !== 'admin') {
      return res.status(403).json({ error: "Acesso negado." });
    }

    if (req.file) {
      const fileName = `communities/${uuidv4()}-${req.file.originalname}`;
      const { data, error } = await supabase.storage
        .from(AVATAR_BUCKET)
        .upload(fileName, req.file.buffer, { contentType: req.file.mimetype });
      
      if (!error) {
        const { data: publicUrlData } = supabase.storage
          .from(AVATAR_BUCKET)
          .getPublicUrl(fileName);
        imageurl = publicUrlData.publicUrl;
      }
    }

    const maxPart = (max_participantes !== undefined && max_participantes !== "") ? parseInt(max_participantes) : 0;

    const [community] = await sql`
      INSERT INTO comunidades (
        nome, descricao, imageurl, participantes, max_participantes, categoria, 
        tipo_comunidade, duracao, calorias, data_evento, faixa_etaria, 
        premiacao, local_inicio, local_fim, telefone_contato, createdat
      ) VALUES (
        ${nome}, ${descricao}, ${imageurl}, 0, ${maxPart}, ${categoria}, 
        ${tipo_comunidade}, ${duracao}, ${calorias}, ${data_evento}, ${faixa_etaria}, 
        ${premiacao}, ${local_inicio}, ${local_fim}, ${telefone_contato}, NOW()
      ) RETURNING *
    `;

    res.status(201).json({ success: true, data: community });
  } catch (error) {
    console.error("Erro ao criar comunidade:", error);
    res.status(500).json({ error: "Erro ao criar comunidade." });
  }
});

// PUT: Editar comunidade (Admin)
app.put("/api/admin/communities/:id", verifyToken, upload.single('image'), async (req, res) => {
  const userId = req.userId;
  const { id } = req.params;
  let fields = req.body;

  try {
    const [adminCheck] = await sql`SELECT role FROM usuarios WHERE id_us = ${userId}`;
    if (!adminCheck || adminCheck.role !== 'admin') {
      return res.status(403).json({ error: "Acesso negado." });
    }

    if (req.file) {
      const fileName = `communities/${uuidv4()}-${req.file.originalname}`;
      const { data, error } = await supabase.storage
        .from(AVATAR_BUCKET)
        .upload(fileName, req.file.buffer, { contentType: req.file.mimetype });
      
      if (!error) {
        const { data: publicUrlData } = supabase.storage
          .from(AVATAR_BUCKET)
          .getPublicUrl(fileName);
        fields.imageurl = publicUrlData.publicUrl;
      }
    }

    const [updated] = await sql`
      UPDATE comunidades SET
        nome = COALESCE(${fields.nome || null}, nome),
        descricao = COALESCE(${fields.descricao || null}, descricao),
        imageurl = COALESCE(${fields.imageurl || null}, imageurl),
        max_participantes = COALESCE(${(fields.max_participantes !== undefined && fields.max_participantes !== "") ? parseInt(fields.max_participantes) : null}, max_participantes),
        categoria = COALESCE(${fields.categoria || null}, categoria),
        tipo_comunidade = COALESCE(${fields.tipo_comunidade || null}, tipo_comunidade),
        duracao = COALESCE(${fields.duracao || null}, duracao),
        calorias = COALESCE(${fields.calorias || null}, calorias),
        data_evento = COALESCE(${fields.data_evento || null}, data_evento),
        faixa_etaria = COALESCE(${fields.faixa_etaria || null}, faixa_etaria),
        premiacao = COALESCE(${fields.premiacao || null}, premiacao),
        local_inicio = COALESCE(${fields.local_inicio || null}, local_inicio),
        local_fim = COALESCE(${fields.local_fim || null}, local_fim),
        telefone_contato = COALESCE(${fields.telefone_contato || null}, telefone_contato)
      WHERE id_comunidade = ${id}
      RETURNING *
    `;

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error("Erro ao atualizar comunidade:", error);
    res.status(500).json({ error: "Erro ao atualizar comunidade." });
  }
});

// DELETE: Excluir comunidade (Admin)
app.delete("/api/admin/communities/:id", verifyToken, async (req, res) => {
  const userId = req.userId;
  const { id } = req.params;

  try {
    const [adminCheck] = await sql`SELECT role FROM usuarios WHERE id_us = ${userId}`;
    if (!adminCheck || adminCheck.role !== 'admin') {
      return res.status(403).json({ error: "Acesso negado." });
    }

    await sql`DELETE FROM comunidades WHERE id_comunidade = ${id}`;
    res.status(200).json({ success: true, message: "Comunidade excluída com sucesso." });
  } catch (error) {
    console.error("Erro ao excluir comunidade:", error);
    res.status(500).json({ error: "Erro ao excluir comunidade.", details: error.message });
  }
});


// ------------------------- CATEGORIAS DE COMUNIDADE ------------------------- //

app.get("/api/comunidade-categorias", async (req, res) => {
  try {
    const categories = await sql`SELECT nome FROM comunidade_categorias ORDER BY nome ASC`;
    res.json({ success: true, data: categories.map(c => c.nome) });
  } catch (error) {
    console.error("Erro ao listar categorias:", error);
    res.status(500).json({ error: "Erro ao listar categorias." });
  }
});

app.post("/api/admin/comunidade-categorias", verifyToken, async (req, res) => {
  const userId = req.userId;
  const { nome } = req.body;
  if (!nome) return res.status(400).json({ error: "Nome é obrigatório." });

  try {
    const [adminCheck] = await sql`SELECT role FROM usuarios WHERE id_us = ${userId}`;
    if (!adminCheck || adminCheck.role !== 'admin') {
      return res.status(403).json({ error: "Acesso negado." });
    }

    const [category] = await sql`
      INSERT INTO comunidade_categorias (nome) VALUES (${nome})
      ON CONFLICT (nome) DO UPDATE SET nome = EXCLUDED.nome
      RETURNING *
    `;
    res.status(201).json({ success: true, data: category.nome });
  } catch (error) {
    console.error("Erro ao criar categoria:", error);
    res.status(500).json({ error: "Erro ao criar categoria." });
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
    } catch (_e) {
      // Ignorar erro se a busca falhar
    }

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

app.post("/api/appointments", verifyToken, checkFreePlanLimit('agendamentos'), async (req, res) => {
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

// 3. PUT: Atualizar Status do Agendamento (Aprovar/Recusar/Concluir)
app.put("/api/appointments/:id", verifyToken, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const userId = req.userId;

  try {
    const [appt] = await sql`
      UPDATE agendamentos 
      SET status = ${status}, updated_at = NOW()
      WHERE id_agendamento = ${parseInt(id, 10)}
      RETURNING *
    `;

    if (!appt) return res.status(404).json({ error: "Agendamento não encontrado" });

    res.json({ success: true, appointment: appt });
  } catch (err) {
    console.error("[PUT Appointments]", err);
    res.status(500).json({ error: "Erro ao atualizar agendamento" });
  }
});

// 4. GET: Histórico de treinos de um cliente específico (para o personal)
app.get("/api/personal/clients/:clientId/history", verifyToken, async (req, res) => {
  const { clientId } = req.params;
  const trainerId = req.userId;

  try {
    const history = await sql`
      SELECT 
        a.id_agendamento, a.data_agendamento, a.hora_inicio, a.status, a.notas,
        f.nota_intensidade, f.comentario_tecnico, f.nota_aluno
      FROM agendamentos a
      LEFT JOIN feedbacks_trainer f ON a.id_agendamento = f.id_agendamento
      WHERE a.id_trainer = ${trainerId} AND a.id_usuario = ${parseInt(clientId, 10)}
      ORDER BY a.data_agendamento DESC, a.hora_inicio DESC
    `;

    res.json({ success: true, history });
  } catch (err) {
    console.error("[GET Client History]", err);
    res.status(500).json({ error: "Erro ao buscar histórico do cliente" });
  }
});

// 5. POST: Avaliação do Treino pelo Personal
app.post("/api/personal/workouts/evaluation", verifyToken, async (req, res) => {
  const trainerId = req.userId;
  const { id_agendamento, nota_intensidade, comentario_tecnico, nota_aluno } = req.body;

  try {
    // Primeiro, criar a tabela de feedbacks se não existir (para garantir)
    await sql`
      CREATE TABLE IF NOT EXISTS feedbacks_trainer (
        id_feedback SERIAL PRIMARY KEY,
        id_agendamento INTEGER UNIQUE NOT NULL,
        id_trainer INTEGER NOT NULL,
        nota_intensidade INTEGER,
        comentario_tecnico TEXT,
        nota_aluno INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    const [feedback] = await sql`
      INSERT INTO feedbacks_trainer (
        id_agendamento, id_trainer, nota_intensidade, comentario_tecnico, nota_aluno
      ) VALUES (
        ${id_agendamento}, ${trainerId}, ${nota_intensidade}, ${comentario_tecnico}, ${nota_aluno}
      )
      ON CONFLICT (id_agendamento) DO UPDATE SET
        nota_intensidade = EXCLUDED.nota_intensidade,
        comentario_tecnico = EXCLUDED.comentario_tecnico,
        nota_aluno = EXCLUDED.nota_aluno
      RETURNING *
    `;

    // Se avaliar, também marcar como concluído se ainda for confirmado
    await sql`
      UPDATE agendamentos 
      SET status = 'concluido' 
      WHERE id_agendamento = ${id_agendamento} AND status = 'confirmado'
    `;

    res.json({ success: true, feedback });
  } catch (err) {
    console.error("[POST Workout Evaluation]", err);
    res.status(500).json({ error: "Erro ao salvar avaliação do treino" });
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

require('./routes/family')(app, sql, transporter, verifyToken, emailUser);
require('./routes/mercadopago_gym')(app, sql, verifyToken);

// Rotas Administrativas de Academias
const adminGymRoutes = require('./routes/adminGyms')(sql, verifyToken);
app.use('/api/admin/gyms', adminGymRoutes);

// Rotas Administrativas de Treinos
const adminWorkoutRoutes = require('./routes/adminWorkouts')(sql, verifyToken, upload, supabase, AVATAR_BUCKET);
app.use('/api/admin/workouts', adminWorkoutRoutes);

// ==================== ROTA DE RANKING (LEADERBOARD) ==================== //

/**
 * Rota para obter o Ranking Top 10 (Corrida e Ciclismo)
 * query params: sportType (running|cycling), period (weekly|monthly)
 */
app.get("/api/ranking", async (req, res) => {
  const { sportType = 'cycling', period = 'monthly' } = req.query;

  try {
    let dateFilter;
    if (period === 'weekly') {
      dateFilter = sql`created_at >= NOW() - INTERVAL '7 days'`;
    } else {
      dateFilter = sql`created_at >= NOW() - INTERVAL '30 days'`;
    }

    const ranking = await sql`
      SELECT 
        u.id_us,
        u.nome,
        u.avatar_url,
        SUM(a.distance) as total_distance,
        SUM(a.duration) as total_duration,
        (SUM(a.distance) / (SUM(a.duration) / 3600.0)) as avg_speed,
        (SUM(a.duration) / 60.0) / NULLIF(SUM(a.distance), 0) as avg_pace
      FROM activities a
      JOIN usuarios u ON a.id_us = u.id_us
      WHERE a.sport_type = ${sportType}
        AND ${dateFilter}
      GROUP BY u.id_us, u.nome, u.avatar_url
      ORDER BY total_distance DESC, avg_speed DESC
      LIMIT 10
    `;

    res.json(ranking);
  } catch (error) {
    console.error("Erro ao carregar ranking:", error);
    res.status(500).json({ error: "Erro ao carregar o ranking competitivo." });
  }
});


// 6. POST: Upload de Comprovante e Análise por IA (Gemini)
app.post("/api/personal/appointments/:id/receipt", verifyToken, upload.single('receipt'), async (req, res) => {
  const { id } = req.params;
  const trainerId = req.userId;
  const file = req.file;

  if (!file) return res.status(400).json({ error: "Nenhum arquivo enviado." });

  try {
    // 1. Verificar se o agendamento pertence ao personal
    const [appointment] = await sql`
      SELECT * FROM agendamentos 
      WHERE id_agendamento = ${parseInt(id, 10)} AND id_trainer = ${trainerId}
    `;

    if (!appointment) {
      return res.status(404).json({ error: "Agendamento não encontrado." });
    }

    // 2. Analisar o comprovante com Gemini
    const iaResult = await analyzeReceiptDocument(file.buffer, file.mimetype);
    
    if (!iaResult || !iaResult.is_valid_receipt) {
      return res.status(422).json({ 
        error: "Não conseguimos validar o comprovante automaticamente.",
        details: "Tente tirar uma foto mais nítida ou envie outro comprovante." 
      });
    }

    // 3. Upload para o Supabase Storage
    const fileName = `receipts/${uuidv4()}-${file.originalname}`;
    const { data: storageData, error: storageError } = await supabase.storage
      .from('documents') // Assumindo bucket 'documents'
      .upload(fileName, file.buffer, { contentType: file.mimetype });

    if (storageError) {
       // Se o bucket 'documents' não existir, tenta criar ou usar outro. 
       // Simplificando: vamos assumir que o bucket existe ou logar o erro.
       console.error("Erro no Supabase Storage:", storageError);
       // Tenta usar o arquivo original se falhar o storage, mas idealmente deve ter o bucket.
    }

    const fileUrl = `${supabaseUrl}/storage/v1/object/public/documents/${fileName}`;

    // 4. Salvar na tabela de comprovantes e atualizar agendamento
    await sql.begin(async sql => {
      await sql`
        INSERT INTO comprovantes_pagamentos (
          id_agendamento, id_trainer, id_usuario, valor_lido, arquivo_url, metadata_ia, status
        ) VALUES (
          ${appointment.id_agendamento}, ${trainerId}, ${appointment.id_usuario}, 
          ${iaResult.amount || 0}, ${fileUrl}, ${sql.json(iaResult)}, 'aprovado'
        )
      `;

      await sql`
        UPDATE agendamentos 
        SET status = 'confirmado', 
            pagamento_verificado = TRUE, 
            valor_recebido = ${iaResult.amount || 0}
        WHERE id_agendamento = ${appointment.id_agendamento}
      `;
    });

    res.json({ 
      success: true, 
      message: "Comprovante validado e agendamento confirmado!",
      data: {
        amount: iaResult.amount,
        payer: iaResult.payer_name
      }
    });

  } catch (err) {
    console.error("[POST Receipt Upload]", err);
    res.status(500).json({ error: "Erro ao processar comprovante." });
  }
});

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

