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
 * Monta o corpo de UMA mensagem do Expo Push. Centralizado para que `image` e
 * `categoryId` valham igual no chat e no social, sem duplicar regra.
 *
 * Sobre `richContent.image` (doc do Expo): no **Android funciona out of the box**
 * — e, lendo o fonte do expo-notifications (`ExpoNotificationBuilder.kt:152`),
 * ele vira **`setLargeIcon`**, a miniatura ao lado do texto (é ali que o
 * Instagram põe a foto), não uma imagem gigante. No **iOS exige um Notification
 * Service Extension** + `mutableContent: true` — por isso mandamos o flag desde
 * já: sem a extensão ele é inofensivo, e quando ela existir passa a valer sem
 * mexer no backend.
 */
function buildExpoMessage(to, { title, body, data, channelId, threadId, badge, image, categoryId }) {
  return {
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
    // Foto (avatar de quem interagiu / imagem do post).
    ...(image ? { richContent: { image }, mutableContent: true } : {}),
    // Botões de ação (Responder, Aceitar/Recusar, Curtir). A categoria em si é
    // registrada no app (setNotificationCategoryAsync); aqui só referenciamos.
    ...(categoryId ? { categoryId } : {}),
  };
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
 * @param {string} [payload.image]  URL da foto (largeIcon no Android; iOS exige NSE)
 * @param {string} [payload.categoryId]  categoria de ações registrada no app
 */
async function sendPushToUser(sql, userId, payload = {}) {
  try {
    if (!userId) return;
    const tokens = await getUserTokens(sql, userId);
    if (tokens.length === 0) return;

    const messages = tokens.map((to) => buildExpoMessage(to, payload));

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
    case "new_post":
      return "posts";
    default:
      return null;
  }
}

const CATEGORY_COLUMN = {
  chat: "push_chat",
  likes: "push_likes",
  comments: "push_comments",
  follows: "push_follows",
  posts: "push_posts",
};

/**
 * Categorias de AÇÃO (botões na notificação) por tipo. Os identificadores têm de
 * bater EXATAMENTE com os registrados no app via `setNotificationCategoryAsync`
 * (src/services/pushNotificationService.ts) — se divergirem, o SO simplesmente
 * não desenha botão nenhum, silenciosamente.
 *
 * Só tipos com ação ÚTIL entram. `like`/`follow_accepted` ficam de fora de
 * propósito: não há o que fazer além de abrir, e o toque já faz isso.
 */
const ACTION_CATEGORY_FOR_TYPE = {
  chat: "movt_chat",           // Responder (campo de texto)
  comment: "movt_comment",     // Responder (campo de texto)
  comment_diet: "movt_comment",
  follow_request: "movt_follow_request", // Aceitar / Recusar
  new_post: "movt_new_post",   // Curtir
};

/**
 * Lê a linha de preferências do usuário (ou null). Nunca lança — qualquer erro
 * vira null, que os checadores tratam como "tudo liberado" (opt-out).
 */
async function getNotificationPrefs(sql, userId) {
  try {
    const [row] = await sql`
      SELECT push_chat, push_likes, push_comments, push_follows, push_posts,
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
    const senderAvatar = (sender && sender.avatar_url) || null;

    await sendPushToUser(sql, recipientId, {
      title: senderName,
      body: message,
      channelId: "social",
      threadId: "social",
      // A foto de QUEM interagiu — é o que o Instagram mostra na miniatura de
      // curtida/comentário/seguidor (o post em si o usuário já conhece).
      image: senderAvatar || undefined,
      categoryId: ACTION_CATEGORY_FOR_TYPE[type] || undefined,
      data: {
        type,
        reference_id: referenceId != null ? String(referenceId) : null,
        senderId: String(senderId),
        senderName,
        senderAvatar,
      },
    });
  } catch (err) {
    console.error("[pushService] notifySocialPush falhou:", err?.message || err);
  }
}

/**
 * Push de NOVO POST para todos os seguidores aceitos do autor (fan-out).
 *
 * Diferente de `notifySocialPush` (1 destinatário), aqui o N pode ser grande, e
 * na Vercel o processo congela após o `res` — então o caller precisa aguardar.
 * Para não pagar N×queries, tudo é resolvido em **3 queries**, independente do
 * número de seguidores:
 *   1. seguidores + preferências (LEFT JOIN — quem nunca abriu as prefs vem com
 *      null, que a política opt-out trata como "liberado");
 *   2. o autor (nome/avatar para o título e o deep-link);
 *   3. todos os tokens de uma vez.
 * O `postToExpo` já fatia o envio em lotes de 100 (limite da API da Expo).
 *
 * NÃO grava linha em `notifications`: o sino/Atividade é para interações *com
 * você* (curtida, comentário, seguidor). "Fulano publicou" pertence ao feed, e
 * gravar N linhas por post faria a tabela crescer sem leitor. Mesmo padrão do
 * `follow_request`, que também é só push.
 *
 * Silencioso por design (nunca lança) — publicar o post não pode falhar por push.
 *
 * @param {object} sql
 * @param {object} args
 * @param {number} args.authorId  id_us de quem publicou
 * @param {number|string} args.postId  id do post (deep-link)
 * @param {string} [args.caption]  legenda, usada como corpo quando houver
 */
async function notifyNewPostToFollowers(sql, { authorId, postId, caption, imageUrl }) {
  try {
    if (!authorId || !postId) return;

    const rows = await sql`
      SELECT f.follower_user_id AS user_id,
             p.push_posts, p.quiet_hours_enabled, p.quiet_start, p.quiet_end, p.timezone
      FROM follows f
      LEFT JOIN notification_prefs p ON p.user_id = f.follower_user_id
      WHERE f.followed_user_id = ${authorId} AND f.status = 'accepted'
    `;

    const recipients = rows
      .filter((row) => isCategoryAllowed(row, "posts") && !isQuietNow(row))
      .map((row) => row.user_id);
    if (recipients.length === 0) return;

    const [author] = await sql`SELECT username, avatar_url FROM usuarios WHERE id_us = ${authorId}`;
    const authorName = (author && author.username) || "MOVT";

    const tokenRows = await sql`SELECT token FROM push_tokens WHERE user_id = ANY(${recipients})`;
    const tokens = tokenRows.map((r) => r.token).filter(isExpoToken);
    if (tokens.length === 0) return;

    const trimmed = typeof caption === "string" ? caption.trim() : "";
    const body = trimmed
      ? trimmed.length > 120
        ? trimmed.slice(0, 119) + "…"
        : trimmed
      : "fez uma nova publicação.";

    const data = {
      type: "new_post",
      reference_id: String(postId),
      senderId: String(authorId),
      senderName: authorName,
      senderAvatar: (author && author.avatar_url) || null,
      // Vai no `data` além do richContent porque o banner IN-APP (app aberto)
      // não enxerga o richContent — ele monta o card a partir daqui.
      image: imageUrl || null,
    };

    const messages = tokens.map((to) =>
      buildExpoMessage(to, {
        title: authorName,
        body,
        data,
        channelId: "social",
        threadId: "social",
        // Aqui a miniatura certa é a IMAGEM DO POST, não o avatar: é o conteúdo
        // que está sendo anunciado (o autor já vai no título).
        image: imageUrl || undefined,
        categoryId: ACTION_CATEGORY_FOR_TYPE.new_post,
      })
    );

    const tickets = await postToExpo(messages);

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
    console.error("[pushService] notifyNewPostToFollowers falhou:", err?.message || err);
  }
}

module.exports = {
  sendPushToUser,
  getNotificationPrefs,
  isCategoryAllowed,
  isQuietNow,
  notifySocialPush,
  notifyNewPostToFollowers,
};
