const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');

module.exports = (sql, verifyToken, upload, supabase, bucketName) => {

  // Wrapper do multer que devolve erros de upload como JSON limpo (em vez de vazar MulterError)
  const uploadImage = (req, res, next) => {
    upload.single('image')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: 'Imagem muito grande. Tamanho máximo: 10MB.' });
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
          return res.status(400).json({ error: 'Formato de imagem inválido. Use JPG, PNG, GIF ou WEBP.' });
        }
        return res.status(400).json({ error: 'Erro ao processar a imagem.', details: err.message });
      }
      next();
    });
  };

  // Middleware para verificar se é admin
  const verifyAdmin = async (req, res, next) => {
    try {
      if (!req.userId) {
        console.log('[AdminExercises] req.userId não definido.');
        return res.status(401).json({ error: 'Não autenticado.' });
      }
      const users = await sql`SELECT role FROM usuarios WHERE id_us = ${req.userId}`;
      const user = users[0];
      if (!user || user.role !== 'admin') {
        console.log(`[AdminExercises] Usuário ${req.userId} não é admin (role: ${user?.role}).`);
        return res.status(403).json({ error: 'Acesso negado. Apenas administradores.' });
      }
      next();
    } catch (err) {
      res.status(500).json({ error: 'Erro ao verificar permissões.' });
    }
  };

  // Função auxiliar para upload no Supabase
  const uploadToSupabase = async (file) => {
    const uuid = uuidv4();
    const ext = file.originalname.split('.').pop();
    const path = `exercicios/${uuid}.${ext}`;

    const { error } = await supabase.storage
      .from(bucketName)
      .upload(path, file.buffer, {
        contentType: file.mimetype,
        upsert: true
      });

    if (error) throw error;

    const { data: publicUrlData } = supabase.storage
      .from(bucketName)
      .getPublicUrl(path);

    return publicUrlData.publicUrl;
  };

  // GET: Listar todos os exercícios do catálogo global (Admin)
  router.get('/', verifyToken, verifyAdmin, async (req, res) => {
    try {
      const exercicios = await sql`
        SELECT id as id_exercicio, nome, descricao, image_url, categoria, created_at
        FROM exercicios
        ORDER BY nome ASC
      `;
      res.json({ success: true, data: exercicios });
    } catch (err) {
      console.error('[AdminExercises] Erro ao listar:', err);
      res.status(500).json({ error: 'Erro ao buscar exercícios.' });
    }
  });

  // POST: Criar novo exercício no catálogo global
  router.post('/', verifyToken, verifyAdmin, uploadImage, async (req, res) => {
    let { nome, descricao, categoria } = req.body;

    if (!nome) {
      return res.status(400).json({ error: 'O nome do exercício é obrigatório.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'A imagem do exercício é obrigatória.' });
    }

    try {
      const image_url = await uploadToSupabase(req.file);

      const [novo] = await sql`
        INSERT INTO exercicios (nome, descricao, categoria, image_url, created_at)
        VALUES (
          ${nome}, ${descricao || null}, ${categoria || 'Geral'}, ${image_url || null}, NOW()
        )
        RETURNING id as id_exercicio, nome, descricao, image_url, categoria, created_at
      `;
      res.status(201).json({ success: true, data: novo });
    } catch (err) {
      console.error('[AdminExercises] Erro ao criar:', err);
      res.status(500).json({ error: 'Erro ao criar exercício.', details: err.message });
    }
  });

  // PUT: Editar exercício existente
  router.put('/:id', verifyToken, verifyAdmin, uploadImage, async (req, res) => {
    const exerciseId = parseInt(req.params.id, 10);
    let { nome, descricao, categoria, image_url } = req.body;

    if (isNaN(exerciseId)) {
      return res.status(400).json({ error: 'ID de exercício inválido.' });
    }

    try {
      if (req.file) {
        image_url = await uploadToSupabase(req.file);
      }

      const [atualizado] = await sql`
        UPDATE exercicios SET
          nome = COALESCE(${nome || null}, nome),
          descricao = COALESCE(${descricao || null}, descricao),
          categoria = COALESCE(${categoria || null}, categoria),
          image_url = COALESCE(${image_url || null}, image_url)
        WHERE id = ${exerciseId}
        RETURNING id as id_exercicio, nome, descricao, image_url, categoria, created_at
      `;

      if (!atualizado) {
        return res.status(404).json({ error: 'Exercício não encontrado.' });
      }

      res.json({ success: true, data: atualizado });
    } catch (err) {
      console.error('[AdminExercises] Erro ao atualizar:', err);
      res.status(500).json({ error: 'Erro ao atualizar exercício.', details: err.message });
    }
  });

  // DELETE: Excluir exercício (bloqueado se estiver em uso por algum treino)
  router.delete('/:id', verifyToken, verifyAdmin, async (req, res) => {
    const exerciseId = parseInt(req.params.id, 10);

    if (isNaN(exerciseId)) {
      return res.status(400).json({ error: 'ID de exercício inválido.' });
    }

    try {
      // Verifica se algum treino referencia este exercício no JSONB exercicios[].id_exercicio
      const emUso = await sql`
        SELECT id, title
        FROM conteudo_treinos
        WHERE exercicios @> ${sql.json([{ id_exercicio: exerciseId }])}
        LIMIT 5
      `;

      if (emUso.length > 0) {
        return res.status(409).json({
          error: 'Exercício em uso por treino(s) e não pode ser excluído.',
          treinos: emUso.map((t) => t.title),
        });
      }

      const deletedArr = await sql`
        DELETE FROM exercicios WHERE id = ${exerciseId} RETURNING id
      `;

      if (!deletedArr[0]) {
        return res.status(404).json({ error: 'Exercício não encontrado.' });
      }

      res.json({ success: true, message: 'Exercício excluído com sucesso.' });
    } catch (err) {
      console.error('[AdminExercises] Erro ao excluir:', err);
      res.status(500).json({ error: 'Erro ao excluir exercício.', details: err.message });
    }
  });

  return router;
};
