require("dotenv").config();
const express = require("express");
const postgres = require("postgres");
const bcrypt = require("bcrypt");
const { v4: uuidv4 } = require("uuid");
const nodemailer = require("nodemailer");
const crypto = require("crypto");
const multer = require("multer");
const sharp = require("sharp");
const { createClient } = require("@supabase/supabase-js");

const databaseUrl = process.env.DATABASE_URL;
const emailUser = process.env.EMAIL_USER;
const emailPass = process.env.EMAIL_PASS;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Inicializar cliente Supabase para Storage
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
  ssl: "require",
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
});

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

const app = express();
const port = 3000;

app.use(express.json());

// Middleware de verificação de sessão
function verifyToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res
      .status(403)
      .json({ message: "Token de sessão não fornecido ou formato inválido." });
  }

  const sessionId = authHeader.split(" ")[1];

  sql`SELECT id_us FROM usuarios WHERE session_id = ${sessionId}`
    .then((users) => {
      if (users.length === 0) {
        return res
          .status(401)
          .json({ message: "Token de sessão inválido ou expirado." });
      }
      req.userId = users[0].id_us;
      next();
    })
    .catch((error) => {
      console.error("Erro na verificação do token de sessão:", error);
      res.status(500).json({
        error: "Erro interno do servidor na verificação do token.",
        details: error.message,
      });
    });
}

// ==================== CONFIGURAÇÃO DE UPLOAD DE AVATAR ==================== //

// Configuração do Multer
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

app.post("/login", async (req, res) => {
  console.log("Rota /login atingida");
  const { email, senha, sessionId: providedSessionId } = req.body;

  if (!email || !senha) {
    return res.status(400).json({ error: "Email e senha são obrigatórios." });
  }

  try {
    const [user] = await sql`
      SELECT id_us, email, senha, username, nome, session_id, email_verified
      FROM usuarios
      WHERE email = ${email};
    `;

    if (!user) {
      return res
        .status(401)
        .json({ error: "Endereço de e-mail incorreto, tente novamente!" });
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

    res.status(200).json({
      message: "Login bem-sucedido!",
      user: {
        id: user.id_us,
        nome: user.nome,
        username: user.username,
        email: user.email,
        isVerified: user.email_verified,
      },
      sessionId: user.session_id,
    });
  } catch (error) {
    console.error("Erro ao autenticar usuário:", error);
    res.status(500).json({
      error: "Erro interno do servidor ao autenticar usuário.",
      details: error.message,
    });
  }
});

app.post("/register", async (req, res) => {
  console.log("Rota /register atingida");
  console.log("Dados recebidos do frontend (req.body):", req.body);
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

    res.status(201).json({
      message: "Usuário registrado com sucesso! Verifique seu e-mail.",
      user: newUser,
      sessionId: newSessionId,
    });
  } catch (error) {
    console.error("Erro ao registrar usuário:", error);
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

// --------------------- VERIFICAÇÃO DE USUÁRIO --------------------- //

app.post("/user/send-verification", verifyToken, async (req, res) => {
  console.log("Rota /user/send-verification atingida");
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

app.post("/user/verify", verifyToken, async (req, res) => {
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

app.get("/user/session-status", verifyToken, async (req, res) => {
  console.log("Rota /user/session-status atingida");
  const userId = req.userId;

  try {
    const [user] = await sql`
      SELECT id_us, email, username, nome, email_verified
      FROM usuarios
      WHERE id_us = ${userId};
    `;

    if (!user) {
      return res
        .status(404)
        .json({ error: "Usuário não encontrado para a sessão ativa." });
    }

    res.status(200).json({
      message: "Sessão ativa.",
      user: {
        id: user.id_us,
        nome: user.nome,
        username: user.username,
        email: user.email,
        isVerified: user.email_verified,
      },
    });
  } catch (error) {
    console.error("Erro ao obter status da sessão:", error);
    res.status(500).json({
      error: "Erro interno do servidor ao obter status da sessão.",
      details: error.message,
    });
  }
});

// -------------------------------- UPLOAD DE AVATAR ---------------------------- //

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

// ROTA GENÉRICA: Atualizar um único campo do perfil (username ou email)
app.put("/api/user/update-field", verifyToken, async (req, res) => {
  const userId = req.userId;
  const { field, value } = req.body;

  if (!field || !value) {
    return res.status(400).json({ error: "Informe 'field' e 'value' no corpo da requisição." });
  }

  // Permitir apenas campos controlados
  const allowed = ["username", "email"];
  if (!allowed.includes(field)) {
    return res.status(400).json({ error: "Campo inválido. Apenas 'username' ou 'email' são permitidos." });
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

      // Atualiza somente o username; NÃO altera/zera a coluna email
      await sql`
        UPDATE usuarios
        SET username = ${value}, updatedat = ${now}
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

      // Atualiza somente o email; NÃO altera/zera a coluna username
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

    return res.status(200).json({ success: true, data: {
      id: updated.id_us,
      username: updated.username,
      email: updated.email,
      isVerified: updated.email_verified,
    }});
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
  const id = req.params.id;
  try {
    const [row] = await sql`
      SELECT id_us AS id, nome AS name, username, avatar_url, updatedat
      FROM usuarios
      WHERE id_us = ${id}
      LIMIT 1
    `;
    if (!row) return res.status(404).json({ error: "Trainer não encontrado." });
    return res.status(200).json({ data: row });
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

    // Check if personal_profiles table exists
    const [{ exists }] = await sql`SELECT to_regclass('public.personal_profiles') IS NOT NULL AS exists`;
    if (!exists) {
      return res.status(200).json({ data: [], meta: { total: 0, limit, offset } });
    }

    if (q) {
      const pattern = `%${q}%`;
      const data = await sql`
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
        WHERE u.role = 'personal' AND (u.username ILIKE ${pattern} OR u.nome ILIKE ${pattern})
        ORDER BY u.nome
        LIMIT ${limit} OFFSET ${offset}
      `;
      const [{ count } = { count: null }] = await sql`
        SELECT count(*) FROM usuarios WHERE role = 'personal' AND (username ILIKE ${pattern} OR nome ILIKE ${pattern})
      `;
      return res.status(200).json({ data, meta: { total: parseInt(count, 10) || data.length, limit, offset } });
    }

    const data = await sql`
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
      WHERE u.role = 'personal'
      ORDER BY u.nome
      LIMIT ${limit} OFFSET ${offset}
    `;
    const [{ count } = { count: null }] = await sql`SELECT count(*) FROM usuarios WHERE role = 'personal'`;
    return res.status(200).json({ data, meta: { total: parseInt(count, 10) || data.length, limit, offset } });
  } catch (err) {
    console.error("Erro em GET /api/personals:", err);
    return res.status(500).json({ error: "Erro interno ao listar personals." });
  }
});

// Upload de cover/avatar para um trainer (processa e retorna URLs; NÃO grava em colunas desconhecidas)
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

// Unfollow múltiplos trainers de uma vez
app.post("/api/trainers/unfollow-multiple", verifyToken, async (req, res) => {
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

    // Deleta múltiplos follows
    await sql`
      DELETE FROM follows 
      WHERE follower_user_id = ${userId} AND trainer_id = ANY(${validIds})
    `;

    return res.status(200).json({ 
      success: true, 
      message: `${validIds.length} trainer(s) removido(s) com sucesso.`,
      unfollowedCount: validIds.length 
    });
  } catch (err) {
    console.error("Erro em POST /api/trainers/unfollow-multiple", err);
    return res.status(500).json({ error: "Erro interno ao deixar de seguir múltiplos trainers." });
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
app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  const limit = parseInt(req.query.limit) || 10;
  const offset = parseInt(req.query.offset) || 0;
  if (!q) return res.status(400).json({ error: "Query 'q' é obrigatória." });
  try {
    const pattern = `%${q}%`;
    const trainers = await sql`
      SELECT id_us AS id, nome AS title, username AS subtitle
      FROM usuarios
      WHERE nome ILIKE ${pattern} OR username ILIKE ${pattern}
      LIMIT ${limit} OFFSET ${offset}
    `;
    // Retornar tipo para frontend decidir a tela target
    const results = trainers.map((t) => ({ id: t.id, title: t.title, subtitle: t.subtitle, type: "trainer", target: "TrainerProfile" }));
    return res.status(200).json({ data: results, meta: { total: results.length, limit, offset } });
  } catch (err) {
    console.error("Erro em GET /api/search", err);
    return res.status(500).json({ error: "Erro interno na busca." });
  }
});

// Notifications (consulta básica se tabela existir)
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

app.post("/api/dietas", verifyToken, async (req, res) => {
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
  console.log("--- DADOS EXTRAÍDOS ---");
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
    console.log("❌ ERRO: Nome não fornecido");
  } else {
    console.log("✅ Nome válido:", nome);
  }

  if (!descricao) {
    validationErrors.push("Descrição é obrigatória");
    console.log("❌ ERRO: Descrição não fornecida");
  } else {
    console.log("✅ Descrição válida:", descricao.substring(0, 50) + "...");
  }

  if (!imageurl) {
    validationErrors.push("URL da imagem é obrigatória");
    console.log("❌ ERRO: URL da imagem não fornecida");
  } else {
    console.log("✅ URL da imagem válida:", imageurl);
  }

  if (!categoria) {
    validationErrors.push("Categoria é obrigatória");
    console.log("❌ ERRO: Categoria não fornecida");
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
      await sql`SELECT nome, username, email FROM usuarios WHERE id_us = ${userId}`;

    if (!author) {
      console.log("❌ ERRO: Usuário autor não encontrado no banco de dados");
      console.log("=== FIM DA ROTA POST /api/dietas (ERRO 404) ===");
      return res.status(404).json({ error: "Usuário autor não encontrado." });
    }

    console.log("✅ Autor encontrado:", {
      nome: author.nome,
      username: author.username,
      email: author.email,
    });

    const authorName = author.nome || author.username || null;
    const authorAvatarUrl = getGravatarUrl(author.email);

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
    console.error("❌ ERRO ao criar dieta:", error);
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
  console.log("Rota GET /api/dietas atingida");
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
  console.log("Rota PUT /api/dietas/:id_dieta atingida");
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
  console.log("Rota DELETE /api/dietas/:id_dieta atingida");
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

// -------------------------------- CHAT ---------------------------- //

app.post("/api/chat", verifyToken, async (req, res) => {
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
  console.log("--- DADOS EXTRAÍDOS ---");
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
    console.log("❌ ERRO: Nome não fornecido");
  } else {
    console.log("✅ Nome válido:", nome);
  }

  if (!descricao) {
    validationErrors.push("Descrição é obrigatória");
    console.log("❌ ERRO: Descrição não fornecida");
  } else {
    console.log("✅ Descrição válida:", descricao.substring(0, 50) + "...");
  }

  if (!imageurl) {
    validationErrors.push("URL da imagem é obrigatória");
    console.log("❌ ERRO: URL da imagem não fornecida");
  } else {
    console.log("✅ URL da imagem válida:", imageurl);
  }

  if (!categoria) {
    validationErrors.push("Categoria é obrigatória");
    console.log("❌ ERRO: Categoria não fornecida");
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
      await sql`SELECT nome, username, email FROM usuarios WHERE id_us = ${userId}`;

    if (!author) {
      console.log("❌ ERRO: Usuário autor não encontrado no banco de dados");
      console.log("=== FIM DA ROTA POST /api/dietas (ERRO 404) ===");
      return res.status(404).json({ error: "Usuário autor não encontrado." });
    }

    console.log("✅ Autor encontrado:", {
      nome: author.nome,
      username: author.username,
      email: author.email,
    });

    const authorName = author.nome || author.username || null;
    const authorAvatarUrl = getGravatarUrl(author.email);

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
    console.error("❌ ERRO ao criar dieta:", error);
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

app.get("/api/chat", verifyToken, async (req, res) => {
  dados;
  console.log("Rota GET /api/dietas atingida");
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

app.put("/api/chat/:id_chat", verifyToken, async (req, res) => {
  console.log("Rota PUT /api/dietas/:id_dieta atingida");
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

app.delete("/api/chat/:id_chat", verifyToken, async (req, res) => {
  console.log("Rota DELETE /api/dietas/:id_dieta atingida");
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
  console.log("--- DADOS EXTRAÍDOS ---");
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
    console.log("❌ ERRO: Nome não fornecido");
  } else {
    console.log("✅ Nome válido:", nome);
  }

  if (!descricao) {
    validationErrors.push("Descrição é obrigatória");
    console.log("❌ ERRO: Descrição não fornecida");
  } else {
    console.log("✅ Descrição válida:", descricao.substring(0, 50) + "...");
  }

  if (!imageurl) {
    validationErrors.push("URL da imagem é obrigatória");
    console.log("❌ ERRO: URL da imagem não fornecida");
  } else {
    console.log("✅ URL da imagem válida:", imageurl);
  }

  if (!categoria) {
    validationErrors.push("Categoria é obrigatória");
    console.log("❌ ERRO: Categoria não fornecida");
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
      await sql`SELECT nome, username, email FROM usuarios WHERE id_us = ${userId}`;

    if (!author) {
      console.log("❌ ERRO: Usuário autor não encontrado no banco de dados");
      console.log("=== FIM DA ROTA POST /api/dietas (ERRO 404) ===");
      return res.status(404).json({ error: "Usuário autor não encontrado." });
    }

    console.log("✅ Autor encontrado:", {
      nome: author.nome,
      username: author.username,
      email: author.email,
    });

    const authorName = author.nome || author.username || null;
    const authorAvatarUrl = getGravatarUrl(author.email);

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
    console.error("❌ ERRO ao criar dieta:", error);
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
  console.log("Rota GET /api/dietas atingida");
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
  console.log("Rota PUT /api/dietas/:id_dieta atingida");
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
  console.log("Rota DELETE /api/dietas/:id_dieta atingida");
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
  console.log("Rota GET /api/comunidades atingida");
  const userId = req.userId;
  const { categoria } = req.query;

  try {
    let query = sql`
      SELECT id_comunidade, nome, descricao, imageurl, participantes, max_participantes, categoria, tipo_comunidade
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
  console.log("Rota GET /api/comunidades/:id_comunidade atingida");
  const { id_comunidade } = req.params;

  try {
    const [comunidade] = await sql`
      SELECT id_comunidade, nome, descricao, imageurl, participantes, max_participantes, categoria, tipo_comunidade, id_us
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
  console.log("Rota POST /api/comunidades atingida");
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

// POST: Entrar na comunidade (Simulação de incremento)
app.post("/api/comunidades/:id_comunidade/entrar", verifyToken, async (req, res) => {
  console.log("Rota POST /api/comunidades/:id_comunidade/entrar atingida");
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
      return res.status(404).json({ error: "Comunidade não encontrada." });
    }

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
  console.log("Rota DELETE /api/comunidades/:id_comunidade atingida");
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

// -------------------------------- DADOS DE CALORIAS ---------------------------- //

// GET: Buscar dados de calorias
app.get("/api/dados/calories", verifyToken, async (req, res) => {
  console.log("=== INÍCIO DA ROTA GET /api/dados/calories ===");
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
    console.error("❌ Erro ao buscar dados de calorias:", error);
    console.log("=== FIM DA ROTA GET /api/dados/calories (ERRO 500) ===");
    res.status(500).json({
      error: "Erro interno do servidor ao buscar dados de calorias.",
      details: error.message,
    });
  }
});

// POST: Salvar dados de calorias
app.post("/api/dados/calories", verifyToken, async (req, res) => {
  console.log("=== INÍCIO DA ROTA POST /api/dados/calories ===");
  console.log("Timestamp:", new Date().toISOString());
  console.log("User ID:", req.userId);
  console.log("Body:", req.body);

  const userId = req.userId;
  const { calories, timestamp } = req.body;

  if (!calories) {
    console.log("❌ Erro: Calorias não fornecidas");
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
    console.error("❌ Erro ao salvar dados de calorias:", error);
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
  console.log("=== INÍCIO DA ROTA POST /api/wearos/register-device ===");
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
    console.log("❌ Erro: Nome e modelo do dispositivo são obrigatórios");
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
      console.log("✅ Dispositivo já registrado para o usuário:", existingDevice[0].id_disp);
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
    console.error("❌ Erro ao registrar dispositivo Wear OS:", error);
    console.log("=== FIM DA ROTA POST /api/wearos/register-device (ERRO) ===");
    res.status(500).json({
      error: "Erro interno do servidor ao registrar dispositivo.",
      details: error.message
    });
  }
});

// GET: Listar dispositivos Wear OS do usuário ✅
app.get("/api/wearos/devices", verifyToken, async (req, res) => {
  console.log("=== INÍCIO DA ROTA GET /api/wearos/devices ===");
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
    console.error("❌ Erro ao listar dispositivos Wear OS:", error);
    console.log("=== FIM DA ROTA GET /api/wearos/devices (ERRO) ===");
    res.status(500).json({
      error: "Erro interno do servidor ao listar dispositivos.",
      details: error.message
    });
  }
});

// GET: Verificar se o usuário tem dispositivos Wear OS registrados ✅
app.get("/api/wearos/devicesON", verifyToken, async (req, res) => {
  console.log("=== INÍCIO DA ROTA GET /api/wearos/has-devices ===");
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

    console.log(`✅ Usuário ${userId} tem ${result[0].device_count} dispositivos Wear OS`);
    console.log("=== FIM DA ROTA GET /api/wearos/has-devices ===");

    res.status(200).json({
      hasDevices: hasDevices,
      deviceCount: parseInt(result[0].device_count)
    });
  } catch (error) {
    console.error("❌ Erro ao verificar dispositivos Wear OS:", error);
    console.log("=== FIM DA ROTA GET /api/wearos/has-devices (ERRO) ===");
    res.status(500).json({
      error: "Erro interno do servidor ao verificar dispositivos.",
      details: error.message
    });
  }
});

// POST: Registrar dados de saúde do Wear OS
app.post("/api/wearos/health", verifyToken, async (req, res) => {
  console.log("=== INÍCIO DA ROTA POST /api/wearos/health-data ===");
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
    console.log("❌ Erro: ID do dispositivo é obrigatório");
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
    console.log("❌ Erro: Dispositivo não encontrado ou não pertence ao usuário");
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
    console.error("❌ Erro ao registrar dados de saúde:", error);
    console.log("=== FIM DA ROTA POST /api/wearos/health-data (ERRO) ===");
    res.status(500).json({
      error: "Erro interno do servidor ao registrar dados de saúde.",
      details: error.message
    });
  }
});

// GET: Obter dados de saúde mais recentes de dispositivos Wear OS ✅
app.get("/api/wearos/health", verifyToken, async (req, res) => {
  console.log("=== INÍCIO DA ROTA GET /api/wearos/latest-health-data ===");
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
      console.log("✅ Nenhum dispositivo Wear OS encontrado para o usuário");
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
    console.error("❌ Erro ao obter dados de saúde:", error);
    console.log("=== FIM DA ROTA GET /api/wearos/latest-health-data (ERRO) ===");
    res.status(500).json({
      error: "Erro interno do servidor ao obter dados de saúde.",
      details: error.message
    });
  }
});

// GET: Obter histórico de dados de saúde do Wear OS ✅
app.get("/api/wearos/health-history", verifyToken, async (req, res) => {
  console.log("=== INÍCIO DA ROTA GET /api/wearos/health-history ===");
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
    console.error("❌ Erro ao obter histórico de saúde:", error);
    console.log("=== FIM DA ROTA GET /api/wearos/health-history (ERRO) ===");
    res.status(500).json({
      error: "Erro interno do servidor ao obter histórico de saúde.",
      details: error.message
    });
  }
});

// PUT: Atualizar status do dispositivo Wear OS
app.put("/api/wearos/status/:deviceId", verifyToken, async (req, res) => {
  console.log("=== INÍCIO DA ROTA PUT /api/wearos/device-status/:deviceId ===");
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
    console.error("❌ Erro ao atualizar status do dispositivo:", error);
    console.log("=== FIM DA ROTA PUT /api/wearos/device-status/:deviceId (ERRO) ===");
    res.status(500).json({
      error: "Erro interno do servidor ao atualizar status do dispositivo.",
      details: error.message
    });
  }
});

// DELETE: Remover dispositivo Wear OS
app.delete("/api/wearos/device/:deviceId", verifyToken, async (req, res) => {
  console.log("=== INÍCIO DA ROTA DELETE /api/wearos/device/:deviceId ===");
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

// -------------------------------- AGENDAMENTOS (BOOKINGS/APPOINTMENTS) -------------------------------- //

// GET: Buscar disponibilidade do trainer
app.get("/api/appointments/availability/:trainerId", async (req, res) => {
  const trainerId = req.params.trainerId;
  const { date } = req.query; // YYYY-MM-DD
  
  try {
    if (!trainerId || isNaN(parseInt(trainerId, 10))) {
      return res.status(400).json({ error: "ID do trainer inválido." });
    }

    console.log(`[/api/appointments/availability/${trainerId}] Buscando disponibilidade para date=${date}`);

    // Verificar se a tabela disponibilidade_trainer existe
    const [{ exists: dispExists }] = await sql`SELECT to_regclass('public.disponibilidade_trainer') IS NOT NULL AS exists`;
    if (!dispExists) {
      console.warn("[GET /appointments/availability] Tabela disponibilidade_trainer não existe");
      return res.status(200).json({
        availableSlots: [],
        bookedSlots: [],
        available: false,
        message: "Disponibilidades não configuradas para este trainer"
      });
    }

    // Buscar disponibilidade do trainer (horários configurados)
    const availability = await sql`
      SELECT 
        id,
        id_trainer,
        dia_semana,
        hora_inicio,
        hora_fim,
        ativo,
        createdat,
        updatedat
      FROM disponibilidade_trainer
      WHERE id_trainer = ${parseInt(trainerId, 10)} AND ativo = TRUE
      ORDER BY dia_semana ASC, hora_inicio ASC
    `;

    console.log(`[/api/appointments/availability/${trainerId}] Encontrados ${availability.length} registros de disponibilidade`);

    if (!date) {
      // Retorna disponibilidade semanal padrão
      return res.status(200).json({
        availability: availability,
        message: "Disponibilidade semanal do trainer"
      });
    }

    // Se uma data específica foi informada, retorna horários disponíveis nesse dia
    const searchDate = new Date(date);
    const dayOfWeek = searchDate.getDay();

    console.log(`[/api/appointments/availability/${trainerId}] Procurando para dia da semana: ${dayOfWeek}`);

    const dayAvailability = availability.filter(a => a.dia_semana === dayOfWeek);

    if (dayAvailability.length === 0) {
      return res.status(200).json({
        date: date,
        available: false,
        availableSlots: [],
        bookedSlots: [],
        message: "Trainer não tem disponibilidade neste dia"
      });
    }

    // Buscar agendamentos já feitos nesta data
    let bookedSlots = [];
    try {
      bookedSlots = await sql`
        SELECT hora_inicio, hora_fim FROM agendamentos
        WHERE id_trainer = ${parseInt(trainerId, 10)}
          AND data_agendamento = ${date}
          AND status IN ('pendente', 'confirmado')
      `;
    } catch (bookErr) {
      console.warn(`[/api/appointments/availability/${trainerId}] Erro ao buscar agendamentos:`, bookErr.message);
    }

    // Calcular slots livres
    const availableSlots = [];
    dayAvailability.forEach(slot => {
      try {
        const slotStart = slot.hora_inicio;
        const slotEnd = slot.hora_fim;
        
        console.log(`[/api/appointments/availability/${trainerId}] Processando slot: ${slotStart} - ${slotEnd}`);
        
        // Gerar horários em intervalos de 1 hora
        let current = new Date(`2000-01-01 ${slotStart}`);
        const end = new Date(`2000-01-01 ${slotEnd}`);
        
        while (current < end) {
          const currentTime = current.toTimeString().substring(0, 5);
          const nextHour = new Date(current.getTime() + 60 * 60 * 1000);
          const nextTime = nextHour.toTimeString().substring(0, 5);

          // Verificar se este horário não conflita com reservas
          const conflict = bookedSlots.some(book => {
            return currentTime >= book.hora_inicio && currentTime < book.hora_fim;
          });

          if (!conflict) {
            availableSlots.push({
              startTime: currentTime,
              endTime: nextTime,
              available: true
            });
          }

          current = nextHour;
        }
      } catch (slotErr) {
        console.error(`[/api/appointments/availability/${trainerId}] Erro ao processar slot:`, slotErr.message);
      }
    });

    console.log(`[/api/appointments/availability/${trainerId}] Retornando ${availableSlots.length} slots disponíveis`);

    return res.status(200).json({
      date: date,
      available: availableSlots.length > 0,
      availableSlots: availableSlots,
      bookedSlots: bookedSlots
    });
  } catch (err) {
    console.error(`[/api/appointments/availability/${trainerId}] Erro geral:`, err.message);
    return res.status(500).json({ error: "Erro ao buscar disponibilidade.", details: err.message });
  }
});

// POST: Criar agendamento
app.post("/api/appointments", verifyToken, async (req, res) => {
  const userId = req.userId;
  const { trainerId, date, startTime, endTime, notes } = req.body;

  try {
    if (!trainerId || !date || !startTime || !endTime) {
      return res.status(400).json({ error: "Trainer ID, data, hora de início e fim são obrigatórios." });
    }

    const [{ exists }] = await sql`SELECT to_regclass('public.agendamentos') IS NOT NULL AS exists`;
    if (!exists) {
      return res.status(501).json({ error: "Sistema de agendamentos não instalado." });
    }

    // Verificar se o trainer existe
    const trainerExists = await sql`
      SELECT id_us FROM usuarios WHERE id_us = ${parseInt(trainerId, 10)} 
      AND (role = 'trainer' OR role = 'personal')
    `;
    if (!trainerExists || trainerExists.length === 0) {
      return res.status(404).json({ error: "Trainer não encontrado." });
    }

    // Verificar disponibilidade usando a função PL/pgsql
    const [availCheck] = await sql`
      SELECT * FROM verificar_disponibilidade(
        ${parseInt(trainerId, 10)},
        ${date}::DATE,
        ${startTime}::TIME,
        ${endTime}::TIME
      )
    `;

    if (!availCheck.disponivel) {
      return res.status(409).json({ 
        error: availCheck.motivo || "Horário não disponível" 
      });
    }

    // Criar o agendamento
    const [appointment] = await sql`
      INSERT INTO agendamentos (
        id_trainer, id_usuario, data_agendamento, hora_inicio, 
        hora_fim, status, notas, created_at, updated_at
      )
      VALUES (
        ${parseInt(trainerId, 10)}, ${userId}, ${date}, 
        ${startTime}, ${endTime}, 'pendente', ${notes || null},
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
      RETURNING *
    `;

    return res.status(201).json({
      success: true,
      message: "Agendamento criado com sucesso!",
      appointment: appointment
    });
  } catch (err) {
    console.error("Erro em POST /api/appointments", err);
    if (err.code === '23505') {
      return res.status(409).json({ error: "Já existe um agendamento neste horário." });
    }
    return res.status(500).json({ error: "Erro ao criar agendamento." });
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
          u.nome as trainer_name, u.email as trainer_email, u.avatar_url as trainer_avatar
        FROM agendamentos a
        JOIN usuarios u ON a.id_trainer = u.id_us
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
          console.log(`✓ Executado: ${statement.substring(0, 50)}...`);
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

// -------------------------------- INICIALIZAÇÃO ---------------------------- //

if (process.env.NODE_ENV !== 'production') {
  app.listen(port, "0.0.0.0", () => {
    console.log(`Servidor rodando em http://localhost:${port}`);
    console.log(`Servidor também acessível via IP da rede local`);
  });
}

module.exports = app;
