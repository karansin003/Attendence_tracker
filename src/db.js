/**
 * App database — tiny built-in JSON store (data/db.json, atomic write via
 * temp+rename). NOTE: lowdb v5/v6/v7 me export-path/ESM issues the (Node 24),
 * isliye ek hi file me 40-line store kaafi hai — same "halka, file-based,
 * zero setup" spirit. Multi-user schema:
 *   users:  { id, email, passwordHash (bcrypt),
 *             qumsQid, qumsPasswordEncrypted (AES-256-GCM), qumsSessionPath,
 *             telegramLinkCode, telegramChatId, createdAt }
 *   resets: { email, tokenHash, expiresAt }  (forgot-password tokens, 1h)
 *
 * QUMS password is NEVER stored in plain text — see src/crypto.js.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DB_FILE = path.join(__dirname, '..', 'data', 'db.json');
const QUMS_SESSION_DIR = path.join(__dirname, '..', 'data', 'qums-sessions');

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
fs.mkdirSync(QUMS_SESSION_DIR, { recursive: true });

let data = { users: [], resets: [], knownAttendance: [], weeklySchedule: [] };
try {
  const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  data = {
    users: raw.users || [],
    resets: raw.resets || [],
    knownAttendance: raw.knownAttendance || [],
    weeklySchedule: raw.weeklySchedule || [],
  };
} catch {
  /* first run — defaults */
}

// Machine-portable QUMS sessions: db.json me store kiya gaya qumsSessionPath
// PURANE machine ka absolute path ho sakta hai (e.g. Mac -> Windows/Render
// migrate karte waqt). Session file HAMESHA canonical path pe hoti hai
// (qums-login-web.js isi pe save karta hai), isliye load pe normalize karo.
// Isse multi-user deploy machine-agnostic ban jata hai — koi user-specific
// path db me "sach" nahi hota.
let sessionPathsFixed = false;
for (const u of data.users) {
  if (u.qumsSessionPath) {
    const canonical = path.join(QUMS_SESSION_DIR, `${u.id}.json`);
    if (u.qumsSessionPath !== canonical) {
      u.qumsSessionPath = canonical;
      sessionPathsFixed = true;
    }
  }
}
if (sessionPathsFixed) persist();

function persist() {
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function hasUsers() {
  return data.users.length > 0;
}

function allUsers() {
  return data.users.slice();
}

function getUserByEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return data.users.find((u) => u.email === e) || null;
}

function getUserById(id) {
  return data.users.find((u) => u.id === id) || null;
}

function createUser({ email, passwordHash }) {
  const user = {
    id: newId(),
    email: String(email).trim().toLowerCase(),
    passwordHash,
    qumsQid: '',
    qumsPasswordEncrypted: '',
    qumsSessionPath: '',
    telegramLinkCode: '',
    telegramChatId: '',
    createdAt: new Date().toISOString(),
  };
  data.users.push(user);
  persist();
  return user;
}

function updateUser(id, patch) {
  const user = getUserById(id);
  if (user) Object.assign(user, patch);
  persist();
  return getUserById(id);
}

function sessionPathFor(userId) {
  return path.join(QUMS_SESSION_DIR, `${userId}.json`);
}

// ---- forgot-password tokens ----
function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function storeResetToken(email, token) {
  // ek email pe ek hi active token
  data.resets = data.resets.filter((r) => r.email !== String(email).toLowerCase());
  data.resets.push({
    email: String(email).toLowerCase(),
    tokenHash: tokenHash(token),
    expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour
  });
  persist();
}

function consumeResetToken(token) {
  const h = tokenHash(token);
  const rec = data.resets.find((r) => r.tokenHash === h) || null;
  if (!rec) return null;
  data.resets = data.resets.filter((r) => r.tokenHash !== h);
  persist();
  if (Date.now() > rec.expiresAt) return null;
  return getUserByEmail(rec.email);
}

// ---- known attendance (month-register dedupe; "known_attendance" table) ----
// Per-user records: { key, date, subjectCode, subject, status, teacher,
//                     lectureIndex, lecturesThatDay, seenAt }
const KNOWN_ATTENDANCE_CAP = 5000; // per user — purani entries chhod do

function knownAttendanceEntry(userId) {
  return data.knownAttendance.find((k) => k.userId === userId) || null;
}

function listKnownAttendance(userId) {
  const entry = knownAttendanceEntry(userId);
  return entry ? entry.records.slice() : [];
}

function addKnownAttendance(userId, records) {
  let entry = knownAttendanceEntry(userId);
  if (!entry) {
    entry = { userId, records: [] };
    data.knownAttendance.push(entry);
  }
  const seen = new Set(entry.records.map((r) => r.key));
  let added = 0;
  for (const rec of records || []) {
    if (!rec || !rec.key || seen.has(rec.key)) continue;
    entry.records.push({ ...rec, seenAt: new Date().toISOString() });
    seen.add(rec.key);
    added += 1;
  }
  if (entry.records.length > KNOWN_ATTENDANCE_CAP) {
    entry.records = entry.records.slice(-KNOWN_ATTENDANCE_CAP);
  }
  if (added) persist();
  return added;
}

function removeKnownAttendance(userId, keys) {
  const entry = knownAttendanceEntry(userId);
  if (!entry) return 0;
  const drop = new Set(Array.isArray(keys) ? keys : [keys]);
  const before = entry.records.length;
  entry.records = entry.records.filter((r) => !drop.has(r.key));
  const removed = before - entry.records.length;
  if (removed) persist();
  return removed;
}

// ---- weekly schedule cache (7-day TTL; PK: userId + dayOfWeek + period) ----
// Spec: student ka weekly timetable fixed/repeating hota hai. Pehle hafte har
// din live scrape se cache build hoti hai; uske baad morning message mostly
// cache se fast banta hai, aur har 7 din me ek baar auto-refresh ho jata hai.
const WEEKLY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function weeklyRowsFor(userId, dayOfWeek) {
  return data.weeklySchedule.filter(
    (r) => r.userId === userId && r.dayOfWeek === dayOfWeek
  );
}

/** rows: [{ period, subject, subjectCode, teacher, room }] — upsert (PK per period). */
function upsertWeeklySchedule(userId, dayOfWeek, rows) {
  let changed = false;
  for (const row of rows || []) {
    if (!row || !row.period) continue;
    const hit = data.weeklySchedule.find(
      (r) => r.userId === userId && r.dayOfWeek === dayOfWeek && r.period === row.period
    );
    const patch = {
      subject: row.subject || '',
      subjectCode: row.subjectCode || '',
      teacher: row.teacher || '',
      room: row.room || '',
      lastUpdated: new Date().toISOString(),
    };
    if (hit) {
      Object.assign(hit, patch);
    } else {
      data.weeklySchedule.push({ userId, dayOfWeek, period: row.period, ...patch });
    }
    changed = true;
  }
  if (changed) persist();
  return (rows || []).length;
}

/**
 * Cached rows for (userId, dayOfWeek). Returns:
 *   { fresh: Boolean, rows: [{ period, subject, subjectCode, teacher, room }] }
 * fresh = entries exist AND sab se nayi lastUpdated 7 din se purani nahi.
 */
function getWeeklySchedule(userId, dayOfWeek) {
  const rows = weeklyRowsFor(userId, dayOfWeek);
  if (!rows.length) return { fresh: false, rows: [] };
  const newest = Math.max(...rows.map((r) => Date.parse(r.lastUpdated) || 0));
  const fresh = Date.now() - newest < WEEKLY_TTL_MS;
  return {
    fresh,
    rows: rows.map((r) => ({
      period: r.period,
      duration: '',
      subject: r.subject,
      subjectCode: r.subjectCode,
      teacher: r.teacher,
      room: r.room,
    })),
  };
}

/** Force-refresh ke liye: (userId[, dayOfWeek]) ki cached entries delete. */
function clearWeeklySchedule(userId, dayOfWeek) {
  const before = data.weeklySchedule.length;
  data.weeklySchedule = data.weeklySchedule.filter(
    (r) => !(r.userId === userId && (dayOfWeek === undefined || r.dayOfWeek === dayOfWeek))
  );
  const removed = before - data.weeklySchedule.length;
  if (removed) persist();
  return removed;
}

// ---- telegram linking (deep-link flow; purane WhatsApp channel ki jagah) ----
// users schema add: telegramLinkCode (dashboard->bot deep-link payload),
//                   telegramChatId (/start par save hota hai)

function telegramLinkCodeFor(userId) {
  const user = getUserById(userId);
  if (!user) return null;
  if (!user.telegramLinkCode) {
    user.telegramLinkCode = crypto.randomBytes(6).toString('hex'); // 12 hex chars
    persist();
  }
  return user.telegramLinkCode;
}

function getUserByTelegramLinkCode(code) {
  const c = String(code || '').trim();
  if (!c) return null;
  return data.users.find((u) => u.telegramLinkCode && u.telegramLinkCode === c) || null;
}

function getUserByTelegramChatId(chatId) {
  const c = String(chatId || '').trim();
  if (!c) return null;
  return data.users.find((u) => u.telegramChatId && String(u.telegramChatId) === c) || null;
}

function setTelegramChatId(userId, chatId) {
  const user = getUserById(userId);
  if (!user) return null;
  user.telegramChatId = String(chatId).trim();
  persist();
  return user;
}

/**
 * PRIVACY GUARANTEE: ek Telegram chat sirf EK account se linked rahegi.
 * Naya /start <code> same chat pe aaye to dusre users ka is chat pe koi
 * binding khatam — warna purane user ke updates bhi isi chat pe aa sakte the.
 */
function clearTelegramChatForChat(chatId, exceptUserId) {
  const c = String(chatId || '').trim();
  if (!c) return 0;
  let cleared = 0;
  for (const u of data.users) {
    if (u.id !== exceptUserId && u.telegramChatId && String(u.telegramChatId) === c) {
      u.telegramChatId = '';
      cleared += 1;
    }
  }
  if (cleared) persist();
  return cleared;
}

function clearTelegramChatId(userId) {
  const user = getUserById(userId);
  if (!user) return null;
  user.telegramChatId = '';
  persist();
  return user;
}

/** Test/cleanup helper — user row delete (cascade-ish: knownAttendance entry bhi). */
function deleteUser(userId) {
  const before = data.users.length;
  data.users = data.users.filter((u) => u.id !== userId);
  data.knownAttendance = data.knownAttendance.filter((k) => k.userId !== userId);
  const removed = before - data.users.length;
  if (removed) persist();
  return removed;
}

module.exports = {
  DB_FILE,
  QUMS_SESSION_DIR,
  hasUsers,
  allUsers,
  getUserByEmail,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
  sessionPathFor,
  storeResetToken,
  consumeResetToken,
  listKnownAttendance,
  addKnownAttendance,
  removeKnownAttendance,
  upsertWeeklySchedule,
  getWeeklySchedule,
  clearWeeklySchedule,
  telegramLinkCodeFor,
  getUserByTelegramLinkCode,
  getUserByTelegramChatId,
  setTelegramChatId,
  clearTelegramChatId,
  clearTelegramChatForChat,
};
