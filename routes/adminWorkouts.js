const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');

module.exports = (sql, verifyToken, upload, supabase, bucketName) => {

  // Middleware para verificar se é admin
  const verifyAdmin = async (req, res, next) => {
    try {
      if (!req.userId) {
        console.log('[AdminWorkouts] req.userId não definido.');
        return res.status(401).json({ error: 'Não autenticado.' });
      }
      const users = await sql`SELECT role FROM usuarios WHERE id_us = ${req.userId}`;
      const user = users[0];
      if (!user || user.role !== 'admin') {
        console.log(`[AdminWorkouts] Usuário ${req.userId} não é admin (role: ${user?.role}).`);
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
    let { nome, calorias, duracao, image_url, categoria, nivel, descricao, exercicios, secao_home } = req.body;
    
    if (!nome) {
        return res.status(400).json({ error: 'O nome do treino é obrigatório.' });
    }

    try {
      if (req.file) {
        image_url = await uploadToSupabase(req.file);
      }

      // Se exercicios vier como string (devido ao FormData), convertemos para JSON
      const exerciciosJson = typeof exercicios === 'string' ? JSON.parse(exercicios) : (exercicios || []);

      const [newWorkout] = await sql`
        INSERT INTO conteudo_treinos (
          title, calories, minutes, image_url, specialty, level, description, exercicios, secao_home, ativo, created_at
        ) VALUES (
          ${nome}, ${calorias || null}, ${duracao || null}, ${image_url || null}, 
          ${categoria || 'Geral'}, ${nivel || 'Iniciante'}, ${descricao || null}, ${sql.json(exerciciosJson)},
          ${secao_home || null}, TRUE, NOW()
        ) RETURNING id as id_treino, title as nome, calories as calorias, minutes as duracao, 
          image_url as imageurl, specialty as categoria, level as nivel, 
          description as descricao, exercicios, secao_home, created_at
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
    const workoutId = parseInt(id, 10);
    let { nome, calorias, duracao, image_url, categoria, nivel, descricao, exercicios, secao_home } = req.body;

    console.log(`[AdminWorkouts] Tentando atualizar treino ID: ${workoutId}`);

    if (isNaN(workoutId)) {
      return res.status(400).json({ error: 'ID de treino inválido.' });
    }

    try {
      if (req.file) {
        image_url = await uploadToSupabase(req.file);
      }

      const exerciciosJson = typeof exercicios === 'string' ? JSON.parse(exercicios) : (exercicios || []);

      const [updatedWorkout] = await sql`
        UPDATE conteudo_treinos SET
          title = COALESCE(${nome || null}, title),
          calories = COALESCE(${calorias || null}, calories),
          minutes = COALESCE(${duracao || null}, minutes),
          image_url = COALESCE(${image_url || null}, image_url),
          specialty = COALESCE(${categoria || null}, specialty),
          level = COALESCE(${nivel || null}, level),
          description = COALESCE(${descricao || null}, description),
          exercicios = COALESCE(${sql.json(exerciciosJson)}, exercicios),
          secao_home = ${secao_home !== undefined ? (secao_home || null) : sql`secao_home`},
          ativo = TRUE
        WHERE id = ${workoutId}
        RETURNING id as id_treino, title as nome, calories as calorias, minutes as duracao, 
          image_url as imageurl, specialty as categoria, level as nivel, 
          description as descricao, exercicios, secao_home, created_at
      `;

      if (!updatedWorkout) {
          return res.status(404).json({ error: 'Treino não encontrado.' });
      }

      res.json({ success: true, data: updatedWorkout });
    } catch (err) {
      console.error('[AdminWorkouts] Erro ao atualizar treino:', err);
      res.status(500).json({ error: 'Erro ao atualizar treino.', details: err.message });
    }
  });

  // DELETE: Excluir treino
  router.delete('/:id', verifyToken, verifyAdmin, async (req, res) => {
    const { id } = req.params;
    const workoutId = parseInt(id, 10);
    console.log(`[AdminWorkouts] Tentando excluir treino ID: ${workoutId}`);
    
    if (isNaN(workoutId)) {
      return res.status(400).json({ error: 'ID de treino inválido.' });
    }

    try {
      const deletedArr = await sql`
        DELETE FROM conteudo_treinos WHERE id = ${workoutId} RETURNING id
      `;
      const deleted = deletedArr[0];
      
      if (!deleted) {
          console.log(`[AdminWorkouts] Treino ${id} não encontrado.`);
          return res.status(404).json({ error: 'Treino não encontrado.' });
      }

      console.log(`[AdminWorkouts] Treino ${id} excluído com sucesso.`);
      res.json({ success: true, message: 'Treino excluído com sucesso.' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao excluir treino.' });
    }
  });

  return router;
};
