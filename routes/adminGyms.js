const express = require('express');
const axios = require('axios');
const router = express.Router();
const { 
  autocompletePlaces, 
  getPlaceDetails, 
  extractAddressComponents,
  transformOpeningHours
} = require('../services/googlePlacesService');

module.exports = (sql, verifyToken) => {

  // Middleware para verificar se é admin
  const verifyAdmin = async (req, res, next) => {
    try {
      const [user] = await sql`SELECT role FROM usuarios WHERE id_us = ${req.userId}`;
      if (!user || user.role?.toLowerCase() !== 'admin') {
        return res.status(403).json({ error: "Acesso negado. Apenas administradores." });
      }
      next();
    } catch (err) {
      res.status(500).json({ error: "Erro ao verificar permissão." });
    }
  };

  // GET: Listar todas as academias com contagem de profissionais
  router.get('/', verifyToken, verifyAdmin, async (req, res) => {
    try {
      const gyms = await sql`
        SELECT 
          a.*,
          a.total_avaliacoes as user_ratings_total,
          (SELECT COUNT(*) FROM gym_trainers gt WHERE gt.gym_id = a.id_academia AND gt.status = 'active') as trainers_count
        FROM academias a
        ORDER BY a.createdat DESC
      `;
      res.json({ success: true, data: gyms });
    } catch (err) {
      console.error("❌ Erro GET /admin/gyms:", err);
      res.status(500).json({ error: "Erro ao listar academias." });
    }
  });

  // POST: Criar nova academia
  router.post('/', verifyToken, verifyAdmin, async (req, res) => {
    const { 
      nome, endereco_completo, latitude, longitude, 
      telefone, whatsapp, rua, numero, bairro, cidade, estado, cep,
      google_place_id, rating, user_ratings_total, photos, opening_hours
    } = req.body;

    // Validação: Não permitir cadastro sem nenhum contato para evitar inconsistência
    const hasContact = (telefone && telefone.trim() !== "") || (whatsapp && whatsapp.trim() !== "");

    if (!hasContact) {
      return res.status(400).json({ 
        success: false, 
        error: "Não é possível cadastrar uma academia sem informações de contato (Telefone ou WhatsApp)." 
      });
    }

    try {
      const [newGym] = await sql`
        INSERT INTO academias (
          nome, endereco_completo, latitude, longitude, 
          telefone, whatsapp, rua, numero, bairro, cidade, estado, cep,
          google_place_id, ativo, createdat, updatedat,
          rating, total_avaliacoes, dados_google_cache, ultima_atualizacao_google,
          website, horarios_funcionamento, fotos
        ) VALUES (
          ${nome}, ${endereco_completo}, ${latitude}, ${longitude},
          ${telefone}, ${whatsapp}, ${rua}, ${numero}, ${bairro}, ${cidade}, ${estado}, ${cep},
          ${google_place_id || null}, TRUE, NOW(), NOW(),
          ${rating || 0}, ${user_ratings_total || 0}, 
          ${JSON.stringify({ photos, opening_hours, formatted_address: endereco_completo })}, 
          NOW(),
          ${req.body.website || null}, 
          ${JSON.stringify(transformOpeningHours(opening_hours))}, 
          ${photos ? photos.map(p => p.photo_reference) : []}
        ) RETURNING *
      `;
      res.status(201).json({ success: true, data: newGym });
    } catch (err) {
      console.error("❌ ERRO AO CADASTRAR ACADEMIA:", err);
      res.status(500).json({ error: "Erro ao cadastrar academia.", details: err.message });
    }
  });

  // PUT: Editar academia
  router.put('/:id', verifyToken, verifyAdmin, async (req, res) => {
    const { id } = req.params;
    const fields = req.body;
    
    try {
      const [updatedGym] = await sql`
        UPDATE academias SET
          nome = ${fields.nome},
          endereco_completo = ${fields.endereco_completo},
          latitude = ${fields.latitude},
          longitude = ${fields.longitude},
          telefone = ${fields.telefone},
          whatsapp = ${fields.whatsapp},
          rua = ${fields.rua},
          numero = ${fields.numero},
          bairro = ${fields.bairro},
          cidade = ${fields.cidade},
          estado = ${fields.estado},
          cep = ${fields.cep},
          ativo = ${fields.ativo},
          updatedat = NOW()
        WHERE id_academia = ${id}
        RETURNING *
      `;
      res.json({ success: true, data: updatedGym });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Erro ao atualizar academia." });
    }
  });

  // DELETE: Excluir academia
  router.delete('/:id', verifyToken, verifyAdmin, async (req, res) => {
    const { id } = req.params;
    try {
      await sql`DELETE FROM academias WHERE id_academia = ${id}`;
      res.json({ success: true, message: "Academia excluída com sucesso." });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Erro ao excluir academia." });
    }
  });

  // GET: Listar profissionais vinculados a uma academia
  router.get('/:id/trainers', verifyToken, verifyAdmin, async (req, res) => {
    const { id } = req.params;
    try {
      const trainers = await sql`
        SELECT 
          u.id_us, u.nome, u.email, u.avatar_url,
          gt.status, gt.created_at as linked_at
        FROM gym_trainers gt
        JOIN usuarios u ON gt.personal_id = u.id_us
        WHERE gt.gym_id = ${id}
        ORDER BY gt.created_at DESC
      `;
      res.json({ success: true, data: trainers });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Erro ao listar profissionais." });
    }
  });

  // POST: Vincular profissional a academia
  router.post('/:id/trainers', verifyToken, verifyAdmin, async (req, res) => {
    const { id } = req.params;
    const { trainer_id } = req.body;

    try {
      // Verificar se já existe vínculo
      const [existing] = await sql`
        SELECT id FROM gym_trainers 
        WHERE gym_id = ${id} AND personal_id = ${trainer_id}
      `;

      if (existing) {
        await sql`UPDATE gym_trainers SET status = 'active' WHERE id = ${existing.id}`;
      } else {
        await sql`
          INSERT INTO gym_trainers (gym_id, personal_id, status, created_at)
          VALUES (${id}, ${trainer_id}, 'active', NOW())
        `;
      }
      res.json({ success: true, message: "Profissional vinculado com sucesso." });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Erro ao vincular profissional." });
    }
  });

  // DELETE: Desvincular profissional
  router.delete('/:id/trainers/:trainer_id', verifyToken, verifyAdmin, async (req, res) => {
    const { id, trainer_id } = req.params;
    try {
      await sql`
        DELETE FROM gym_trainers 
        WHERE gym_id = ${id} AND personal_id = ${trainer_id}
      `;
      res.json({ success: true, message: "Profissional desvinculado." });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Erro ao desvincular profissional." });
    }
  });

  // GET: Pesquisar profissionais para vincular
  router.get('/search-trainers', verifyToken, verifyAdmin, async (req, res) => {
    const { query } = req.query;
    try {
      const trainers = await sql`
        SELECT id_us, nome, email, avatar_url
        FROM usuarios
        WHERE (LOWER(role) = 'personal' OR LOWER(role) = 'trainer')
          AND (LOWER(nome) LIKE ${'%' + query.toLowerCase() + '%'} 
               OR LOWER(email) LIKE ${'%' + query.toLowerCase() + '%'})
        LIMIT 10
      `;
      res.json({ success: true, data: trainers });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Erro ao pesquisar profissionais." });
    }
  });

  // ========== GOOGLE PLACES PROXY ROTAS ==========

  // GET: Buscar locais no Google (Autocomplete)
  router.get('/google-search', verifyToken, verifyAdmin, async (req, res) => {
    const { query } = req.query;
    if (!query) return res.json({ success: true, data: [] });

    try {
      const predictions = await autocompletePlaces(query);
      res.json({ success: true, data: predictions });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Erro ao buscar no Google Places." });
    }
  });

  // GET: Obter detalhes do local no Google
  router.get('/google-details/:placeId', verifyToken, verifyAdmin, async (req, res) => {
    const { placeId } = req.params;
    try {
      const details = await getPlaceDetails(placeId);
      const addr = extractAddressComponents(details.address_components);
      
      const rawPhone = details.formatted_phone_number || details.international_phone_number || "";
      const cleanedPhone = rawPhone.replace(/\D/g, "");
      
      // Lógica de Detecção de WhatsApp (Brasil)
      // Formatos: 11999999999 (11 dígitos) ou 5511999999999 (13 dígitos)
      let detectedWhatsapp = "";
      if (cleanedPhone.length === 11 && cleanedPhone[2] === '9') {
        detectedWhatsapp = cleanedPhone;
      } else if (cleanedPhone.length === 13 && cleanedPhone.startsWith('55') && cleanedPhone[4] === '9') {
        detectedWhatsapp = cleanedPhone;
      }

      let finalPhone = rawPhone;
      let finalWebsite = details.website || "";

      // PASSO 3: Fallback de Website - Busca telefone no site se Google falhar
      if (!finalPhone && finalWebsite) {
        try {
          const webResponse = await axios.get(finalWebsite, { timeout: 3500 });
          const html = webResponse.data;
          
          // 1. Prioridade: Links explícitos de WhatsApp ou Telefone
          const linkRegex = /(?:wa\.me\/|api\.whatsapp\.com\/send\?phone=|tel:)(55)?(\d{10,11})/g;
          const linkMatches = [...html.matchAll(linkRegex)];
          
          let potentialNumbers = linkMatches.map(m => m[2]);
          
          // 2. Fallback: Regex de texto (apenas se não achar links)
          if (potentialNumbers.length === 0) {
            const brPhoneRegex = /\(?(\d{2})\)?\s?9\d{4}-?\d{4}/g;
            const textMatches = [...html.matchAll(brPhoneRegex)];
            potentialNumbers = textMatches.map(m => m[1] + m[0].replace(/\D/g, "").slice(-9));
          }

          if (potentialNumbers.length > 0) {
            // Tenta filtrar pelo DDD da região se possível (ex: SP = 11)
            // Se for em SP (Cotia, etc), prioriza 11. 
            const isSP = addr.estado === 'SP' || addr.cidade === 'Cotia' || addr.cidade === 'São Paulo';
            const preferredDDD = isSP ? '11' : null;
            
            let bestMatch = potentialNumbers[0];
            if (preferredDDD) {
              const dddMatch = potentialNumbers.find(n => n.startsWith(preferredDDD));
              if (dddMatch) bestMatch = dddMatch;
            }

            // Formata o melhor match para exibição
            if (bestMatch.length === 11) {
              finalPhone = `(${bestMatch.substring(0, 2)}) ${bestMatch.substring(2, 7)}-${bestMatch.substring(7)}`;
              detectedWhatsapp = bestMatch;
            } else {
              finalPhone = `(${bestMatch.substring(0, 2)}) ${bestMatch.substring(2, 6)}-${bestMatch.substring(6)}`;
            }
          }
        } catch (e) {
          // Falha silenciosa
        }
      }

      const response = {
        nome: details.name,
        endereco_completo: details.formatted_address,
        latitude: details.geometry.location.lat,
        longitude: details.geometry.location.lng,
        telefone: finalPhone,
        whatsapp: detectedWhatsapp, 
        rua: addr.rua || "",
        numero: addr.numero || "",
        bairro: addr.bairro || "",
        cidade: addr.cidade || "",
        estado: addr.estado || "",
        cep: addr.cep || "",
        google_place_id: placeId,
        rating: details.rating || 0,
        user_ratings_total: details.user_ratings_total || 0,
        photos: details.photos || [],
        opening_hours: details.opening_hours || null,
        website: finalWebsite
      };
      
      res.json({ success: true, data: response });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Erro ao buscar detalhes no Google." });
    }
  });

  return router;
};
