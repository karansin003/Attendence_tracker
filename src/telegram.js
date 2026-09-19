require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');

const BOT_USERNAME = (process.env.TELEGRAM_BOT_USERNAME || 'qums_attendance_bot').replace(/^@/, '');
const DEEP_LINK_BASE = `https://t.me/${BOT_USERNAME}`;

let bot = null;
let initAttempted = false; // token add karne ke baad server RESTART chahiye

function isConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN);
}

function isReady() {
  return Boolean(bot);
}

function getBotUsername() {
  return BOT_USERNAME;
}

/** linkCode -> https://t.me/<bot>?start=<code> */
function deepLink(linkCode) {
  return `${DEEP_LINK_BASE}?start=${encodeURIComponent(linkCode)}`;
}

// ---- formatting: WhatsApp-style *bold* / _italic_ -> Telegram HTML ----
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function toTelegramHtml(text) {
  const escaped = escapeHtml(text);
  return escaped
    .replace(/\*(?=\S)(.+?)(?<=\S)\*/gs, '<b>$1</b>')
    .replace(/_(?=\S)(.+?)(?<=\S)_/gs, '<i>$1</i>');
}

/**
 * Per-user send: user ka saved telegramChatId nikal ke message bhejo.
 * Not linked / not configured -> silently skip (false), koi crash nahi.
 * HTML parse fail (rare) -> plain-text fallback.
 *
 * 15I — safe logs: sirf booleans + userId. TELEGRAM_BOT_TOKEN / chatId /
 * connection token KABHI log nahi hota.
 */
async function sendMessage(userId, text, log = console) {
  if (!userId) return false;
  const user = await db.getUserById(userId);
  log.log(`[Telegram] Chat ID available: ${Boolean(user && user.telegramChatId)}`); // boolean only — chatId log NAHI
  if (!user || !user.telegramChatId) return false; // Telegram linked nahi hai
  // Standalone processes (scheduler --now, watcher --send) me polling init
  // nahi hota — send-only bot bana lo (koi getUpdates nahi, 409 conflict nahi).
  if (!bot) {
    if (!isConfigured()) {
      log.log('[Telegram] Telegram connected: false (TELEGRAM_BOT_TOKEN missing) — send skip.');
      return false;
    }
    bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
  }
  log.log('[Telegram] Telegram connected: true');
  try {
    log.log(`[Telegram] Sending notification for user: ${userId}`);
    await bot.sendMessage(user.telegramChatId, toTelegramHtml(text), {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    log.log(`[Telegram] Notification sent successfully for user: ${userId}`);
    return true;
  } catch (err) {
    try {
      await bot.sendMessage(user.telegramChatId, text); // plain-text fallback
      log.log(`[Telegram] Notification sent successfully for user: ${userId} (plain-text fallback)`);
      return true;
    } catch (err2) {
      log.error(`[Telegram] Notification FAILED for user: ${userId}: ${err.message}`);
      throw err; // watcher/scheduler rollback-retry kar sake
    }
  }
}

// ---- linking handlers (deep-link primary, /link backup, /status info) ----

/** "/start <linkCode>" — deep-link flow ka core. Returns linked user ya null. */
async function handleDeepLink(chatId, payload, log = console) {
  const code = String(payload || '').trim();
  const user = code ? await db.getUserByTelegramLinkCode(code) : null;
  if (!user) {
    bot.sendMessage(chatId, '❌ Ye link invalid ya expire ho gaya hai. Dashboard kholke dobara "Connect Telegram" dabao.');
    return null;
  }
  // PRIVACY: ek chat sirf EK account ke updates ke liye — agar ye chat pehle
  // kisi aur account se linked thi to wo binding ab clear (us user ke updates
  // is chat pe aana band).
  const previousOwnerCleared = await db.clearTelegramChatForChat(chatId, user.id);
  await db.setTelegramChatId(user.id, chatId);
  const rebindNote = previousOwnerCleared ? '\n(Note: ye chat pehle kisi aur account se linked thi — ab sirf is account ke updates aayenge.)' : '';
  // bot.sendMessage(chatId, `✅ Connected! Ab aapko attendance updates yahin milenge (${user.email}).${rebindNote}`);
  bot.sendMessage(
    chatId,
    `✅ Connected! Ab aapko attendance updates yahin milenge (${user?.email || 'your account'}).${rebindNote}`
  );
  log.log(`[telegram] 🔗 linked: ${user.email} -> chat ${chatId}${previousOwnerCleared ? ` (rebind: ${previousOwnerCleared} purana binding clear)` : ''}`);
  return user;
}

async function handleStart(chatId, payload, log = console) {
  if (!payload) {
    bot.sendMessage(chatId, "👋 Welcome! QUMS Attendance Bot. Dashboard kholo aur 'Connect Telegram' button dabao — bas itna hi.");
    return;
  }
  await handleDeepLink(chatId, payload, log);
}

/** Backup command: "/link <linkCode>" */
async function handleLinkCommand(chatId, code, log = console) {
  if (!code) {
    bot.sendMessage(chatId, 'Usage: /link <code>  — code dashboard ke "Connect Telegram" section me hai.');
    return;
  }
  await handleDeepLink(chatId, code, log);
}

async function handleStatus(chatId, log = console) {
  const user = await db.getUserByTelegramChatId(chatId);
  if (user) {
    bot.sendMessage(chatId, `🔗 Linked: ${user.email}\nQUMS: ${user.qumsSessionPath ? 'configured ✅' : 'setup pending ⚠️'}`);
  } else {
    bot.sendMessage(chatId, '❌ Koi account linked nahi hai. Dashboard se "Connect Telegram" dabao.');
  }
  log.log(`[telegram] /status from chat ${chatId}`);
}

/** Polling start — token na ho to server crash na ho, sirf warning. */
function initTelegram(log = console) {
  if (initAttempted) return bot;
  initAttempted = true;
  if (!isConfigured()) {
    log.log('[telegram] TELEGRAM_BOT_TOKEN .env me set nahi hai — Telegram DISABLED (server chalega, sends skip honge).');
    return null;
  }
  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
  bot.on('polling_error', (err) => log.error(`[telegram] polling error: ${err.message}`));
  bot.onText(/^\/start(?:\s+(\S+))?/, (msg, match) => {
    handleStart(msg.chat.id, match && match[1], log).catch((e) => log.error(`[telegram] /start failed: ${e.message}`));
  });
  bot.onText(/^\/link(?:\s+(\S+))?/, (msg, match) => {
    handleLinkCommand(msg.chat.id, match && match[1], log).catch((e) => log.error(`[telegram] /link failed: ${e.message}`));
  });
  bot.onText(/^\/status/, (msg) => {
    handleStatus(msg.chat.id, log).catch((e) => log.error(`[telegram] /status failed: ${e.message}`));
  });
  log.log(`[telegram] polling armed (@${BOT_USERNAME}) — deep-link + /link + /status handlers active.`);
  return bot;
}

/**
 * Abhi send kyun block hoga? Accurate error ke liye:
 *   'not-configured'       -> .env me TELEGRAM_BOT_TOKEN nahi
 *   'bot-not-initialized'  -> token tha par polling start nahi hua (restart karo)
 *   'not-linked'           -> user ne Connect Telegram nahi kiya
 *   null                   -> send block nahi hoga
 */
async function sendBlockerReason(userId) {
  if (!isConfigured()) return 'not-configured';
  if (!bot) return 'bot-not-initialized';
  const user = userId ? await db.getUserById(userId) : null;
  if (!user || !user.telegramChatId) return 'not-linked';
  return null;
}

module.exports = {
  initTelegram,
  isConfigured,
  isReady,
  getBotUsername,
  deepLink,
  sendMessage,
  sendBlockerReason,
  handleDeepLink,
  handleStart,
  handleLinkCommand,
  handleStatus,
  toTelegramHtml,
  BOT_USERNAME,
};

// Standalone: token validity + linked users check (koi send nahi, koi polling nahi)
if (require.main === module) {
  (async () => {
    if (!isConfigured()) {
      console.error('[x] TELEGRAM_BOT_TOKEN .env me set nahi hai (BotFather se token le ke daalo).');
      process.exit(1);
    }
    try {
      const probe = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {});
      const me = await probe.getMe();
      console.log(`[OK] Token valid — bot: @${me.username} (id ${me.id})`);
    } catch (err) {
      console.error('[x] Token INVALID:', err.message);
      process.exit(1);
    }
    const linked = (await db.allUsers()).filter((u) => u.telegramChatId);
    console.log(`Linked users: ${linked.length}`);
    linked.forEach((u) => console.log(`  - ${u.email} -> chat ${u.telegramChatId}`));
    process.exit(0);
  })().catch((err) => {
    console.error('[x]', err.message);
    process.exit(1);
  });
}
