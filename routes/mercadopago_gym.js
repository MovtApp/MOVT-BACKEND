const { encrypt, decrypt } = require("../encryption");
const axios = require("axios");

module.exports = function (app, sql, verifyToken) {
  // Rota para validar e conectar credenciais do Mercado Pago para uma academia/barbearia
  app.post("/api/gyms/:id/mercadopago/config", verifyToken, async (req, res) => {
    try {
      const { id } = req.params;
      const { clientId, clientSecret } = req.body;

      if (!clientId || !clientSecret) {
        return res.status(400).json({ error: "Public Key (Client ID) e Access Token (Client Secret) são obrigatórios." });
      }

      console.log(`[MP Config] Validando credenciais para academia ${id}...`);

      // 1. Validar as credenciais chamando a API do Mercado Pago
      try {
        const mpResponse = await axios.get("https://api.mercadopago.com/users/me", {
          headers: {
            Authorization: `Bearer ${clientSecret}`,
          },
        });

        // Validar se o public_key retornado bate com o enviado (opcional, mas seguro)
        // O Mercado Pago retorna public_key no objeto de resposta
        if (mpResponse.data && mpResponse.data.public_key && mpResponse.data.public_key !== clientId) {
           console.warn(`[MP Config] Public Key divergente. Enviada: ${clientId}, Retornada: ${mpResponse.data.public_key}`);
           // Algumas chaves de teste podem se comportar diferente, mas em produção devem bater.
        }

        console.log(`[MP Config] Credenciais validadas com sucesso para: ${mpResponse.data.first_name || 'Usuário MP'}`);
        
      } catch (mpError) {
        console.error("[MP Config] Erro na validação das credenciais:", mpError.response?.data || mpError.message);
        return res.status(401).json({ 
          error: "Credenciais inválidas. Verifique se o Access Token e a Public Key estão corretos.",
          details: mpError.response?.data?.message || mpError.message
        });
      }

      // 2. Criptografar as chaves se a validação passou
      const encryptedPublicKey = encrypt(clientId);
      const encryptedAccessToken = encrypt(clientSecret);

      // 3. Salvar no banco
      await sql`
        UPDATE academias 
        SET mp_public_key = ${encryptedPublicKey}, 
            mp_access_token = ${encryptedAccessToken} 
        WHERE id_academia = ${id}
      `;

      res.status(200).json({ 
        success: true, 
        message: "Conectado com sucesso ao Mercado Pago!",
        integration_status: "active" 
      });
    } catch (error) {
      console.error("Erro ao configurar Mercado Pago:", error);
      res.status(500).json({ error: "Erro interno ao processar a conexão." });
    }
  });

  // Rota para obter a Public Key (descriptografada apenas para o front usar no Checkout Pro)
  app.get("/api/gyms/:id/mercadopago/public-key", async (req, res) => {
    try {
      const { id } = req.params;
      const [gym] = await sql`SELECT mp_public_key FROM academias WHERE id_academia = ${id}`;
      
      if (!gym || !gym.mp_public_key) {
        return res.status(404).json({ error: "Configuração do Mercado Pago não encontrada." });
      }

      const publicKey = decrypt(gym.mp_public_key);
      res.status(200).json({ publicKey });
    } catch (error) {
      console.error("Erro ao buscar public key:", error);
      res.status(500).json({ error: "Erro interno." });
    }
  });
};
