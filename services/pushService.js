// services/pushService.js — entrega de notificações de SO via Expo Push Service.
//
// O Expo Push Service (https://exp.host/--/api/v2/push/send) senta por cima de
// FCM (Android) e APNs (iOS), então uma única chamada entrega a notificação com
// o app fechado, em background ou com a tela bloqueada — exatamente o
// comportamento de WhatsApp/Instagram.
//
// Princípio: envio de push NUNCA pode derrubar a ação principal (mandar mensagem,
// curtir, comentar). Por isso todas as funções públicas são "silenciosas":
// capturam o próprio erro e apenas logam. O caller dispara e segue (fire-and-forget).
//
// `sql` (cliente postgres) é injetado pelo caller (index.js) para reaproveitar o
// mesmo pool de conexões — este módulo não abre conexão própria.

const axios = require("axios");

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_MAX_PER_REQUEST = 100; // limite de mensagens por requisição da API Expo

/** Valida o formato do token Expo, para não mandar lixo à API. */
function isExpoToken(token) {
  return (
    typeof token === "string" &&
    (token.startsWith("ExponentPushToken[") || token.startsWith("ExpoPushToken["))
  );
}

/** Busca todos os tokens válidos de um usuário (por id_us). */
async function getUserTokens(sql, userId) {
  const rows = await sql`SELECT token FROM push_tokens WHERE user_id = ${userId}`;
  return rows.map((r) => r.token).filter(isExpoToken);
}

/** Remove tokens mortos (device desinstalou / revogou permissão). */
async function removeTokens(sql, tokens) {
  if (!tokens || tokens.length === 0) return;
  try {
    await sql`DELETE FROM push_tokens WHERE token = ANY(${tokens})`;
  } catch (err) {
    console.error("[pushService] Falha ao limpar tokens mortos:", err?.message || err);
  }
}

/** Faz o POST para a API da Expo em lotes de 100. Retorna os tickets na ordem. */
async function postToExpo(messages) {
  const tickets = [];
  for (let i = 0; i < messages.length; i += EXPO_MAX_PER_REQUEST) {
    const chunk = messages.slice(i, i + EXPO_MAX_PER_REQUEST);
    const resp = await axios.post(EXPO_PUSH_URL, chunk, {
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      timeout: 15000,
    });
    if (resp.data && Array.isArray(resp.data.data)) {
      tickets.push(...resp.data.data);
    }
  }
  return tickets;
}

/**
 * Envia um push para TODOS os dispositivos de um usuário.
 *
 * @param {object} sql  cliente postgres injetado
 * @param {number} userId  id_us do destinatário
 * @param {object} payload
 * @param {string} payload.title  título (ex.: nome de quem mandou)
 * @param {string} payload.body   corpo (ex.: prévia da mensagem)
 * @param {object} [payload.data] dados para o deep-link no app (ex.: { type, chatId })
 * @param {string} [payload.channelId]  canal Android ('messages' | 'social' | 'reminders')
 * @param {number} [payload.badge]  contador do ícone (iOS)
 */
async function sendPushToUser(sql, userId, { title, body, data, channelId, badge } = {}) {
  try {
    if (!userId) return;
    const tokens = await getUserTokens(sql, userId);
    if (tokens.length === 0) return;

    const messages = tokens.map((to) => ({
      to,
      title,
      body,
      sound: "default",
      data: data || {},
      ...(channelId ? { channelId } : {}),
      ...(typeof badge === "number" ? { badge } : {}),
    }));

    const tickets = await postToExpo(messages);

    // Tokens que a Expo reportou como inválidos → removemos para não acumular lixo.
    const dead = [];
    tickets.forEach((ticket, idx) => {
      if (
        ticket &&
        ticket.status === "error" &&
        ticket.details &&
        ticket.details.error === "DeviceNotRegistered" &&
        messages[idx]
      ) {
        dead.push(messages[idx].to);
      }
    });
    await removeTokens(sql, dead);
  } catch (err) {
    // Silencioso por design: nunca propaga para o handler da rota.
    console.error("[pushService] Falha ao enviar push:", err?.response?.data || err?.message || err);
  }
}

module.exports = { sendPushToUser };
