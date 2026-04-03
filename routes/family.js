module.exports = function (app, sql, transporter, verifyToken, emailUser) {
  // Obter detalhes da família do usuário atual
  app.get("/api/family/details", verifyToken, async (req, res) => {
    try {
      const userId = req.userId;

      // Primeiro, verificar se o usuário é owner ou member
      const users = await sql`SELECT id_us, email, family_group_id, family_role FROM usuarios WHERE id_us = ${userId}`;
      if (users.length === 0) return res.status(404).json({ error: "Usuário não encontrado" });
      const user = users[0];

      let groupId = user.family_group_id;
      let role = user.family_role;

      // Se não tiver grupo vinculado e não for owner, mas tiver um grupo criado, recupera
      if (!groupId && role !== 'owner') {
         const ownedGroups = await sql`SELECT id FROM family_groups WHERE owner_id = ${userId}`;
         if (ownedGroups.length > 0) {
             groupId = ownedGroups[0].id;
             role = 'owner';
         }
      }

      if (!groupId) {
        return res.json({ hasGroup: false });
      }

      // Buscar o grupo e quantidade máxima
      const groups = await sql`SELECT * FROM family_groups WHERE id = ${groupId}`;
      if (groups.length === 0) return res.json({ hasGroup: false });
      const group = groups[0];

      // Buscar membros
      const members = await sql`
        SELECT id_us as id, name, email, plan, family_role, banner, username 
        FROM usuarios 
        WHERE family_group_id = ${groupId} OR id_us = ${group.owner_id}
      `;

      // Buscar convites pendentes
      const invites = await sql`
        SELECT id, email, status, created_at 
        FROM family_invites 
        WHERE group_id = ${groupId} AND status = 'pending'
      `;

      res.json({
        hasGroup: true,
        group,
        role: user.id_us === group.owner_id ? 'owner' : 'member',
        members,
        invites,
        slotsAvailable: group.max_members - members.length - invites.length
      });
    } catch (err) {
      console.error("[Family API] Erro ao buscar detalhes:", err);
      res.status(500).json({ error: "Erro interno" });
    }
  });

  // Enviar convite
  app.post("/api/family/invites", verifyToken, async (req, res) => {
    try {
      const ownerId = req.userId;
      const { email: invitedEmail } = req.body;

      if (!invitedEmail) return res.status(400).json({ error: "Email é obrigatório" });

      const groups = await sql`SELECT * FROM family_groups WHERE owner_id = ${ownerId}`;
      if (groups.length === 0) return res.status(400).json({ error: "Você não possui um plano Família ativo." });
      const group = groups[0];

      // Count members
      const membersCountResult = await sql`SELECT count(*) FROM usuarios WHERE family_group_id = ${group.id} OR id_us = ${ownerId}`;
      // Count pending invites
      const invitesCountResult = await sql`SELECT count(*) FROM family_invites WHERE group_id = ${group.id} AND status = 'pending'`;

      const membersCount = membersCountResult[0].count;
      const invitesCount = invitesCountResult[0].count;

      if (parseInt(membersCount) + parseInt(invitesCount) >= group.max_members) {
        return res.status(400).json({ error: "Limite de vagas atingido." });
      }

      // Check if already invited
      const existingInvites = await sql`SELECT id FROM family_invites WHERE email = ${invitedEmail} AND status = 'pending'`;
      if (existingInvites.length > 0) return res.status(400).json({ error: "Este email já possui um convite pendente." });

      // Check if user is already family member
      const existingUsers = await sql`SELECT id_us FROM usuarios WHERE email = ${invitedEmail} AND family_group_id IS NOT NULL`;
      if (existingUsers.length > 0) return res.status(400).json({ error: "Este usuário já está em um grupo familiar." });

      await sql`
        INSERT INTO family_invites (group_id, email, status) 
        VALUES (${group.id}, ${invitedEmail}, 'pending')
      `;

      // Enviar Email
      const mailOptions = {
        from: `MOVT App <${emailUser}>`,
        to: invitedEmail,
        subject: "Você foi convidado para o MOVT Família!",
        html: `
          <h2>Bem-vindo ao MOVT Família</h2>
          <p>Você foi convidado para participar do plano premium MOVT Família!</p>
          <p>Para aceitar, basta <strong>baixar o aplicativo MOVT</strong>, criar sua conta (ou entrar) utilizando exatamente este endereço de e-mail (<strong>${invitedEmail}</strong>).</p>
          <p>O aplicativo detectará automaticamente seu convite e ativará o acesso Premium.</p>
          <br>
          <p>Equipe MOVT</p>
        `
      };

      try {
        await transporter.sendMail(mailOptions);
        console.log(`Convite enviado para ${invitedEmail}`);
      } catch (e) {
        console.error("Erro ao enviar email de convite:", e);
      }

      res.status(200).json({ success: true, message: "Convite enviado com sucesso!" });
    } catch (err) {
      console.error("[Family API] Erro ao enviar convite:", err);
      res.status(500).json({ error: "Erro interno" });
    }
  });

  // Aceitar convite pendente da conta logada
  app.post("/api/family/invites/accept", verifyToken, async (req, res) => {
    try {
      const userId = req.userId;
      
      const users = await sql`SELECT id_us, email FROM usuarios WHERE id_us = ${userId}`;
      if (users.length === 0) return res.status(404).json({ error: "Usuário não encontrado" });
      const user = users[0];

      const invites = await sql`SELECT * FROM family_invites WHERE email = ${user.email} AND status = 'pending'`;
      if (invites.length === 0) return res.status(400).json({ error: "Nenhum convite pendente encontrado para este email." });
      const invite = invites[0];

      // Update user
      await sql`
        UPDATE usuarios 
        SET family_group_id = ${invite.group_id}, family_role = 'member', plan = 'premium' 
        WHERE id_us = ${userId}
      `;

      // Update invite
      await sql`
        UPDATE family_invites 
        SET status = 'accepted' 
        WHERE id = ${invite.id}
      `;

      res.status(200).json({ success: true, message: "Bem-vindo ao plano Família Premium!" });
    } catch (err) {
      console.error("[Family API] Erro ao aceitar convite:", err);
      res.status(500).json({ error: "Erro interno" });
    }
  });

  // Remover membro do grupo (Owner action)
  app.delete("/api/family/members/:memberId", verifyToken, async (req, res) => {
    try {
      const ownerId = req.userId;
      const { memberId } = req.params;

      const groups = await sql`SELECT * FROM family_groups WHERE owner_id = ${ownerId}`;
      if (groups.length === 0) return res.status(403).json({ error: "Você não possui permissão (Apenas o titular)." });
      const group = groups[0];

      await sql`
        UPDATE usuarios 
        SET family_group_id = NULL, family_role = 'none', plan = 'free' 
        WHERE id_us = ${memberId} AND family_group_id = ${group.id}
      `;

      res.status(200).json({ success: true, message: "Membro removido e plano alterado para free." });
    } catch (err) {
      console.error("[Family API] Erro ao remover membro:", err);
      res.status(500).json({ error: "Erro interno" });
    }
  });

  // Cancelar convite pendente
  app.delete("/api/family/invites/:inviteId", verifyToken, async (req, res) => {
    try {
      const ownerId = req.userId;
      const { inviteId } = req.params;

      const groups = await sql`SELECT * FROM family_groups WHERE owner_id = ${ownerId}`;
      if (groups.length === 0) return res.status(403).json({ error: "Apenas o titular pode cancelar convites." });
      const group = groups[0];

      await sql`
        DELETE FROM family_invites 
        WHERE id = ${inviteId} AND group_id = ${group.id} AND status = 'pending'
      `;

      res.status(200).json({ success: true, message: "Convite cancelado." });
    } catch (err) {
      console.error("[Family API] Erro ao cancelar convite:", err);
      res.status(500).json({ error: "Erro interno" });
    }
  });
};
