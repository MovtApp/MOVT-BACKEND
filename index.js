require('dotenv').config();
const express = require('express');
const postgres = require('postgres');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const databaseUrl = process.env.DATABASE_URL;
const emailUser = process.env.EMAIL_USER;
const emailPass = process.env.EMAIL_PASS;

const sql = postgres(databaseUrl, {
  ssl: 'require',
  max: 1,
  prepare: false
});

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: emailUser,
    pass: emailPass,
  },
  tls: {
    rejectUnauthorized: false
  }
});

function generateVerificationCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function getGravatarUrl(email) {
  const normalizedEmail = (email || '').trim().toLowerCase();
  if (!normalizedEmail) return null;
  const hash = crypto.createHash('md5').update(normalizedEmail).digest('hex');
  return `https://www.gravatar.com/avatar/${hash}?d=identicon&s=200`;
}

async function sendVerificationEmail(toEmail, verificationCode) {
  const mailOptions = {
    from: emailUser,
    to: toEmail,
    subject: 'Verificação de E-mail para MOVT App',
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
    console.error(`Erro ao enviar e-mail de verificação para ${toEmail}:`, error);
    return false;
  }
}

const app = express();
const port = 3000;

app.use(express.json());

// Middleware de verificação de sessão
function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(403).json({ message: 'Token de sessão não fornecido ou formato inválido.' });
  }

  const sessionId = authHeader.split(' ')[1];

  sql`SELECT id_us FROM usuarios WHERE session_id = ${sessionId}`
    .then(users => {
      if (users.length === 0) {
        return res.status(401).json({ message: 'Token de sessão inválido ou expirado.' });
      }
      req.userId = users[0].id_us;
      next();
    })
    .catch(error => {
      console.error('Erro na verificação do token de sessão:', error);
      res.status(500).json({ error: 'Erro interno do servidor na verificação do token.', details: error.message });
    });
}

// ------------------- REGISTRO DE USUÁRIO --------------------- //

app.post('/register', async (req, res) => {
  console.log('Rota /register atingida');
  console.log('Dados recebidos do frontend (req.body):', req.body);
  const { nome, email, senha, cpf_cnpj, data_nascimento, telefone, tipo_documento } = req.body;

  if (!nome || !email || !senha || !cpf_cnpj || !data_nascimento || !telefone) {
    return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
  }

  try {
    let userCpf = null;
    let userCnpj = null;

    if (tipo_documento === 'CPF') {
      userCpf = cpf_cnpj;
    } else if (tipo_documento === 'CNPJ') {
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
        return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });
      } else if (existingUser[0].cpf === userCpf && userCpf !== null) {
        return res.status(409).json({ error: 'Este CPF já está cadastrado.' });
      } else if (existingUser[0].cnpj === userCnpj && userCnpj !== null) {
        return res.status(409).json({ error: 'Este CNPJ já está cadastrado.' });
      } else {
        return res.status(409).json({ error: 'Erro de unicidade no banco de dados.' });
      }
    }

    const hashedPassword = await bcrypt.hash(senha, 10);
    const newSessionId = uuidv4();
    const verificationCode = generateVerificationCode();
    const verificationCodeExpiresAt = new Date(Date.now() + 15 * 60 * 1000);

    const [day, month, year] = data_nascimento.split('/');
    const formattedBirthDate = `${year}-${month}-${day} 00:00:00`;

    const [newUser] = await sql`
      INSERT INTO usuarios (nome, username, email, senha, cpf, cnpj, data_nascimento, telefone, created_at, updated_at, session_id, verification_code, email_verified, verification_code_expires_at)
      VALUES (${nome}, ${email}, ${email}, ${hashedPassword}, ${userCpf}, ${userCnpj}, ${formattedBirthDate}, ${telefone}, NOW(), NOW(), ${newSessionId}, ${verificationCode}, FALSE, ${verificationCodeExpiresAt})
      RETURNING id_us, nome, username, email, cpf, cnpj, data_nascimento, telefone, session_id;
    `;

    const emailSent = await sendVerificationEmail(newUser.email, verificationCode);
    if (!emailSent) {
      console.warn('Falha ao enviar e-mail de verificação para o novo usuário.');
    }

    res.status(201).json({ message: 'Usuário registrado com sucesso! Verifique seu e-mail.', user: newUser, sessionId: newSessionId });
  } catch (error) {
    console.error('Erro ao registrar usuário:', error);
    if (error.code === '23505') {
        return res.status(409).json({ error: 'Erro de unicidade no banco de dados (e.g., email, CPF ou CNPJ).' });
    }
    res.status(500).json({ error: 'Erro interno do servidor ao registrar usuário.', details: error.message });
  }
});

// --------------------- AUTENTICAÇÃO DE USUÁRIO --------------------- //

app.post('/login', async (req, res) => {
  console.log('Rota /login atingida');
  const { email, senha, sessionId: providedSessionId } = req.body;

  if (!email || !senha) {
    return res.status(400).json({ error: 'Email e senha são obrigatórios.' });
  }

  try {
    const [user] = await sql`
      SELECT id_us, email, senha, username, nome, session_id, email_verified
      FROM usuarios
      WHERE email = ${email};
    `;

    if (!user) {
      return res.status(401).json({ error: 'Endereço de e-mail incorreto, tente novamente!' });
    }

    const isPasswordValid = await bcrypt.compare(senha, user.senha);

    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Senha inválida, tente novamente!' });
    }

    if (providedSessionId && providedSessionId !== user.session_id) {
      return res.status(401).json({ error: 'Token de sessão inconsistente ou inválido.' });
    }

    res.status(200).json({ 
      message: 'Login bem-sucedido!', 
      user: { 
        id: user.id_us, 
        nome: user.nome, 
        username: user.username, 
        email: user.email,
        isVerified: user.email_verified
      }, 
      sessionId: user.session_id 
    });
  } catch (error) {
    console.error('Erro ao autenticar usuário:', error);
    res.status(500).json({ error: 'Erro interno do servidor ao autenticar usuário.', details: error.message });
  }
});

// --------------------- VERIFICAÇÃO DE USUÁRIO --------------------- //

app.post('/user/send-verification', verifyToken, async (req, res) => {
  console.log('Rota /user/send-verification atingida');
  const userId = req.userId;

  try {
    const [user] = await sql`SELECT email, email_verified FROM usuarios WHERE id_us = ${userId}`;

    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }
    if (user.email_verified) {
      return res.status(400).json({ message: 'Seu e-mail já está verificado.' });
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

    const emailSent = await sendVerificationEmail(user.email, newVerificationCode);

    if (emailSent) {
      res.status(200).json({ message: 'Novo código de verificação enviado para seu e-mail.' });
    } else {
      res.status(500).json({ error: 'Falha ao enviar o e-mail de verificação.' });
    }
  } catch (error) {
    console.error('Erro ao reenviar código de verificação:', error);
    res.status(500).json({ error: 'Erro interno do servidor ao reenviar código.', details: error.message });
  }
});

app.post('/user/verify', verifyToken, async (req, res) => {
  const userId = req.userId;
  const { code } = req.body;

  if (!code) {
    return res.status(400).json({ error: 'Código de verificação é obrigatório.' });
  }

  try {
    const [user] = await sql`
      SELECT email_verified, verification_code, verification_code_expires_at
      FROM usuarios
      WHERE id_us = ${userId};
    `;

    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }
    if (user.email_verified) {
      return res.status(400).json({ message: 'Seu e-mail já está verificado.' });
    }
    if (!user.verification_code || user.verification_code !== code) {
      return res.status(400).json({ error: 'Código de verificação inválido.' });
    }
    if (user.verification_code_expires_at && new Date() > user.verification_code_expires_at) {
      return res.status(400).json({ error: 'Código de verificação expirado. Solicite um novo.' });
    }

    await sql`
      UPDATE usuarios
      SET email_verified = TRUE,
          verification_code = NULL,
          verification_code_expires_at = NULL,
          updated_at = NOW()
      WHERE id_us = ${userId};
    `;

    res.status(200).json({ message: 'E-mail verificado com sucesso!' });
  } catch (error) {
    console.error('Erro ao verificar e-mail:', error);
    res.status(500).json({ error: 'Erro interno do servidor ao verificar e-mail.', details: error.message });
  }
});

app.get('/user/session-status', verifyToken, async (req, res) => {
  console.log('Rota /user/session-status atingida');
  const userId = req.userId;

  try {
    const [user] = await sql`
      SELECT id_us, email, username, nome, email_verified
      FROM usuarios
      WHERE id_us = ${userId};
    `;

    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado para a sessão ativa.' });
    }

    res.status(200).json({
      message: 'Sessão ativa.',
      user: {
        id: user.id_us,
        nome: user.nome,
        username: user.username,
        email: user.email,
        isVerified: user.email_verified,
      },
    });

  } catch (error) {
    console.error('Erro ao obter status da sessão:', error);
    res.status(500).json({ error: 'Erro interno do servidor ao obter status da sessão.', details: error.message });
  }
});

// -------------------------------- DIETAS ---------------------------- //

app.post('/api/dietas', verifyToken, async (req, res) => {
  console.log('Rota POST /api/dietas atingida');
  const userId = req.userId;
  const {
    nome,
    imageurl,
    categoria,
    calorias,
    tempo_preparo,
    gordura,
    proteina,
    carboidratos
  } = req.body;
  const descricao = req.body.descricao ?? req.body.descripcion ?? null;

  if (!nome || !descricao || !imageurl || !categoria) {
    return res.status(400).json({ error: 'Nome, descrição, imagem e categoria são obrigatórios.' });
  }

  try {
    const [author] = await sql`SELECT nome, username, email FROM usuarios WHERE id_us = ${userId}`;
    if (!author) {
      return res.status(404).json({ error: 'Usuário autor não encontrado.' });
    }

    const authorName = author.nome || author.username || null;
    const authorAvatarUrl = getGravatarUrl(author.email);

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
    res.status(201).json({ message: 'Dieta criada com sucesso!', data: newDieta });
  } catch (error) {
    console.error('Erro ao criar dieta:', error);
    res.status(500).json({ error: 'Erro interno do servidor ao criar dieta.', details: error.message });
  }
});

app.get('/api/dietas', verifyToken, async (req, res) => {
  console.log('Rota GET /api/dietas atingida');
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
    console.error('Erro ao listar dietas:', error);
    res.status(500).json({ error: 'Erro interno do servidor ao listar dietas.', details: error.message });
  }
});

app.put('/api/dietas/:id_dieta', verifyToken, async (req, res) => {
  console.log('Rota PUT /api/dietas/:id_dieta atingida');
  const userId = req.userId;
  const { id_dieta } = req.params;
  const { nome, descricao, imageurl, categoria, calorias, tempo_preparo, gordura, proteina, carboidratos, nome_autor, avatar_autor_url } = req.body;

  if (!nome || !descricao || !imageurl || !categoria) {
    return res.status(400).json({ error: 'Nome, descrição, imagem e categoria são obrigatórios.' });
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
      return res.status(404).json({ error: 'Dieta não encontrada ou você não tem permissão para editá-la.' });
    }
    res.status(200).json({ message: 'Dieta atualizada com sucesso!', data: updatedDieta });
  } catch (error) {
    console.error('Erro ao editar dieta:', error);
    res.status(500).json({ error: 'Erro interno do servidor ao editar dieta.', details: error.message });
  }
});

app.delete('/api/dietas/:id_dieta', verifyToken, async (req, res) => {
  console.log('Rota DELETE /api/dietas/:id_dieta atingida');
  const userId = req.userId;
  const { id_dieta } = req.params;

  try {
    const [deletedDieta] = await sql`
      DELETE FROM dietas
      WHERE id_dieta = ${id_dieta} AND id_us = ${userId}
      RETURNING *;
    `;

    if (!deletedDieta) {
      return res.status(404).json({ error: 'Dieta não encontrada ou você não tem permissão para excluí-la.' });
    }
    res.status(200).json({ message: 'Dieta excluída com sucesso!' });
  } catch (error) {
    console.error('Erro ao excluir dieta:', error);
    res.status(500).json({ error: 'Erro interno do servidor ao excluir dieta.', details: error.message });
  }
});

app.get('/api/meals', verifyToken, async (req, res) => {
  console.log('Rota GET /api/meals atingida');
  try {
    const meals = await sql`
      SELECT * FROM meals ORDER BY nome_refeicao ASC;
    `;
    res.status(200).json({ data: meals });
  } catch (error) {
    console.error('Erro ao listar refeições do catálogo:', error);
    res.status(500).json({ error: 'Erro interno do servidor ao listar refeições.', details: error.message });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
  console.log(`Servidor também acessível via IP da rede local`);
});