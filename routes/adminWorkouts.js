const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');

module.exports = (sql, verifyToken, upload, supabase, bucketName) => {

  // Middleware para verificar se é admin
  const verifyAdmin = async (req, res, next) => {
    try {
      const [user] = await sql`SELECT role FROM usuarios WHERE id_us = ${req.userId}`;
      if (!user || user.role !== 'admin') {
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
    const path = `workouts/${uuid}.${ext}`;

    const { data, error } = await supabase.storage
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

  // GET: Listar todos os treinos (Admin)
  router.get('/', verifyToken, verifyAdmin, async (req, res) => {
    try {
      const workouts = await sql`
        SELECT * FROM conteudo_treinos 
        ORDER BY created_at DESC
      `;
      res.json({ success: true, data: workouts });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao buscar treinos.' });
    }
  });

  // POST: Criar novo treino (com suporte a upload opcional direto)
  router.post('/', verifyToken, verifyAdmin, upload.single('image'), async (req, res) => {
    let { title, calories, minutes, image_url, specialty, level } = req.body;
    
    if (!title) {
        return res.status(400).json({ error: 'O título é obrigatório.' });
    }

    try {
      if (req.file) {
        image_url = await uploadToSupabase(req.file);
      }

      const [newWorkout] = await sql`
        INSERT INTO conteudo_treinos (
          title, calories, minutes, image_url, specialty, level, created_at
        ) VALUES (
          ${title}, ${calories || null}, ${minutes || null}, ${image_url || null}, 
          ${specialty || 'Geral'}, ${level || 'Iniciante'}, NOW()
        ) RETURNING *
      `;
      res.status(201).json({ success: true, data: newWorkout });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao criar treino.' });
    }
  });

  // PUT: Editar treino
  router.put('/:id', verifyToken, verifyAdmin, upload.single('image'), async (req, res) => {
    const { id } = req.params;
    let { title, calories, minutes, image_url, specialty, level } = req.body;

    try {
      if (req.file) {
        image_url = await uploadToSupabase(req.file);
      }

      const [updatedWorkout] = await sql`
        UPDATE conteudo_treinos SET
          title = ${title},
          calories = ${calories},
          minutes = ${minutes},
          image_url = ${image_url},
          specialty = ${specialty},
          level = ${level}
        WHERE id = ${id}
        RETURNING *
      `;

      if (!updatedWorkout) {
          return res.status(404).json({ error: 'Treino não encontrado.' });
      }

      res.json({ success: true, data: updatedWorkout });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao atualizar treino.' });
    }
  });

  // DELETE: Excluir treino
  router.delete('/:id', verifyToken, verifyAdmin, async (req, res) => {
    const { id } = req.params;
    try {
      const [deleted] = await sql`
        DELETE FROM conteudo_treinos WHERE id = ${id} RETURNING id
      `;
      
      if (!deleted) {
          return res.status(404).json({ error: 'Treino não encontrado.' });
      }

      res.json({ success: true, message: 'Treino excluído com sucesso.' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao excluir treino.' });
    }
  });

  return router;
};
