/**
 * Telegram alerts for operational problems (session expiry etc.).
 * Rule: only send if Telegram is configured AND the user has linked their
 * account (telegramChatId), and at most once per COOLDOWN window — no spam.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { isConfigured, sendMessage } = require('./telegram');

const ALERT_STATE_FILE = path.join(__dirname, '..', 'data', 'session_alert_state.json');
const COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12 hours

const SESSION_EXPIRED_TEXT =
  '⚠️ *QUMS session expire ho gaya hai*\n' +
  'Attendance updates (watcher + 9 PM summary) band ho gaye hain.\n\n' +
  'Fix: Dashboard kholo → *QUMS Setup* → "Reconnect QUMS" — sirf captcha solve karna hai (QID/password dobara nahi).\n' +
  '(Server restart ki zaroorat nahi.)';

function readCooldown() {
  try {
    return JSON.parse(fs.readFileSync(ALERT_STATE_FILE, 'utf8'));
  } catch { 
    return {};
  }
}

function writeCooldown(state) {
  fs.mkdirSync(path.dirname(ALERT_STATE_FILE), { recursive: true });
  fs.writeFileSync(ALERT_STATE_FILE, JSON.stringify(state));
}

/**
 * Send the session-expired Telegram alert — but only if:
 *   1. Telegram is configured (token present), and
 *   2. the user has linked their Telegram (telegramChatId), and
 *   3. we haven't alerted within the cooldown window.
 * userId: the app user whose QUMS session died.
 * Returns true if an alert was actually sent.
 */
async function maybeNotifySessionExpired(log = console, userId) {
  try {
    const state = readCooldown();
    if (state.lastSentAt && Date.now() - state.lastSentAt < COOLDOWN_MS) {
      log.log('[alerts] session-expiry alert cooldown me hai — skip.');
      return false;
    }
    if (!isConfigured()) {
      log.log('[alerts] Telegram configured nahi hai (TELEGRAM_BOT_TOKEN missing) — session-expiry alert skip.');
      return false;
    }
    if (!userId) {
      log.log('[alerts] userId nahi mila — session-expiry alert skip.');
      return false;
    }
    const sent = await sendMessage(userId, SESSION_EXPIRED_TEXT);
    if (!sent) {
      log.log('[alerts] user ka Telegram linked nahi hai — session-expiry alert skip (link hone pe agla cycle alert bhejega).');
      return false;
    }
    writeCooldown({ lastSentAt: Date.now() });
    log.log('[alerts] 📲 session-expiry Telegram alert bhej diya.');
    return true;
  } catch (err) {
    log.error(`[alerts] session-expiry alert fail: ${err.message}`);
    return false;
  }
}

module.exports = { maybeNotifySessionExpired, SESSION_EXPIRED_TEXT, COOLDOWN_MS };
