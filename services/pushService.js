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
async function sendPushToUser(sql, userId, { title, body, data, channelId, threadId, badge } = {}) {
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
      // threadId agrupa as notificações por conversa/categoria (iOS thread; no
      // Android o agrupamento é por canal).
      ...(threadId ? { threadId } : {}),
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

// ─── Preferências por categoria ──────────────────────────────────────────────

// Mapeia o `type` da notificação (mesmo vocabulário da tabela `notifications`)
// para a categoria de preferência do usuário.
function categoryForType(type) {
  switch (type) {
    case "chat":
      return "chat";
    case "like":
    case "like_diet":
      return "likes";
    case "comment":
    case "comment_diet":
      return "comments";
    case "follow":
    case "follow_request":
    case "follow_accepted":
      return "follows";
    default:
      return null;
  }
}

const CATEGORY_COLUMN = {
  chat: "push_chat",
  likes: "push_likes",
  comments: "push_comments",
  follows: "push_follows",
};

/**
 * Lê a linha de preferências do usuário (ou null). Nunca lança — qualquer erro
 * vira null, que os checadores tratam como "tudo liberado" (opt-out).
 */
async function getNotificationPrefs(sql, userId) {
  try {
    const [row] = await sql`
      SELECT push_chat, push_likes, push_comments, push_follows,
             hide_message_preview, quiet_hours_enabled, quiet_start, quiet_end, timezone
      FROM notification_prefs WHERE user_id = ${userId}
    `;
    return row || null;
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[pushService] getNotificationPrefs fallback (null):", err?.message || err);
    }
    return null;
  }
}

/**
 * Diz se o usuário permite push de uma categoria. Política opt-out: padrão
 * PERMITIDO (prefs null ou coluna ausente liberam).
 */
function isCategoryAllowed(prefs, category) {
  const column = CATEGORY_COLUMN[category];
  if (!column) return true;
  if (!prefs) return true;
  return prefs[column] !== false;
}

// "HH:MM" -> minutos do dia (0..1439). null se inválido.
function hhmmToMinutes(value) {
  if (typeof value !== "string") return null;
  const m = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// Minutos do dia "agora" no fuso do usuário (default America/Sao_Paulo). null se erro.
function nowMinutesInTz(timezone, now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || "America/Sao_Paulo",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(now);
    const h = parseInt(parts.find((p) => p.type === "hour").value, 10) % 24;
    const min = parseInt(parts.find((p) => p.type === "minute").value, 10);
    return h * 60 + min;
  } catch {
    return null;
  }
}

/**
 * Está dentro do horário silencioso do usuário? Suporta janela que cruza a
 * meia-noite (ex.: 22:00–07:00). Default = false (não silencia) se desligado,
 * inválido ou sem fuso.
 */
function isQuietNow(prefs, now = new Date()) {
  if (!prefs || prefs.quiet_hours_enabled !== true) return false;
  const start = hhmmToMinutes(prefs.quiet_start);
  const end = hhmmToMinutes(prefs.quiet_end);
  const cur = nowMinutesInTz(prefs.timezone, now);
  if (start == null || end == null || cur == null || start === end) return false;
  if (start < end) return cur >= start && cur < end;
  return cur >= start || cur < end; // cruza meia-noite
}

/**
 * Push de notificação SOCIAL (curtida/comentário/seguidor). Resolve o nome de
 * quem interagiu, respeita as preferências do destinatário e manda no canal
 * 'social'. Silencioso por design (nunca lança).
 *
 * @param {object} sql
 * @param {object} args
 * @param {number} args.recipientId  id_us de quem recebe a notificação
 * @param {number} args.senderId     id_us de quem interagiu
 * @param {string} args.type         'like' | 'comment' | 'like_diet' | 'comment_diet' | 'follow_accepted' ...
 * @param {string} args.message      texto pronto (ex.: 'curtiu sua publicação.')
 * @param {number|string} [args.referenceId]  id do post/dieta para o deep-link
 */
async function notifySocialPush(sql, { recipientId, senderId, type, message, referenceId }) {
  try {
    if (!recipientId) return;
    const prefs = await getNotificationPrefs(sql, recipientId);
    const category = categoryForType(type);
    if (category && !isCategoryAllowed(prefs, category)) return;
    if (isQuietNow(prefs)) return;

    const [sender] = await sql`SELECT username, avatar_url FROM usuarios WHERE id_us = ${senderId}`;
    const senderName = (sender && sender.username) || "MOVT";

    await sendPushToUser(sql, recipientId, {
      title: senderName,
      body: message,
      channelId: "social",
      threadId: "social",
      data: {
        type,
        reference_id: referenceId != null ? String(referenceId) : null,
        senderId: String(senderId),
        senderName,
        senderAvatar: (sender && sender.avatar_url) || null,
      },
    });
  } catch (err) {
    console.error("[pushService] notifySocialPush falhou:", err?.message || err);
  }
}

module.exports = {
  sendPushToUser,
  getNotificationPrefs,
  isCategoryAllowed,
  isQuietNow,
  notifySocialPush,
};
