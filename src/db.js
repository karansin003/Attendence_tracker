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
// const path = require('path');
// const fs = require('fs');
// const crypto = require('crypto');

// const DB_FILE = path.join(__dirname, '..', 'data', 'db.json');
// const QUMS_SESSION_DIR = path.join(__dirname, '..', 'data', 'qums-sessions');

// fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
// fs.mkdirSync(QUMS_SESSION_DIR, { recursive: true });

// let data = { users: [], resets: [], knownAttendance: [], weeklySchedule: [] };
// try {
//   const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
//   data = {
//     users: raw.users || [],
//     resets: raw.resets || [],
//     knownAttendance: raw.knownAttendance || [],
//     weeklySchedule: raw.weeklySchedule || [],
//   };
// } catch {
//   /* first run — defaults */
// }

// // Machine-portable QUMS sessions: db.json me store kiya gaya qumsSessionPath
// // PURANE machine ka absolute path ho sakta hai (e.g. Mac -> Windows/Render
// // migrate karte waqt). Session file HAMESHA canonical path pe hoti hai
// // (qums-login-web.js isi pe save karta hai), isliye load pe normalize karo.
// // Isse multi-user deploy machine-agnostic ban jata hai — koi user-specific
// // path db me "sach" nahi hota.
// let sessionPathsFixed = false;
// for (const u of data.users) {
//   if (u.qumsSessionPath) {
//     const canonical = path.join(QUMS_SESSION_DIR, `${u.id}.json`);
//     if (u.qumsSessionPath !== canonical) {
//       u.qumsSessionPath = canonical;
//       sessionPathsFixed = true;
//     }
//   }
// }
// if (sessionPathsFixed) persist();

// function persist() {
//   const tmp = `${DB_FILE}.tmp`;
//   fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
//   fs.renameSync(tmp, DB_FILE);
// }

// function newId() {
//   return crypto.randomBytes(8).toString('hex');
// }

// function hasUsers() {
//   return data.users.length > 0;
// }

// function allUsers() {
//   return data.users.slice();
// }

// function getUserByEmail(email) {
//   const e = String(email || '').trim().toLowerCase();
//   return data.users.find((u) => u.email === e) || null;
// }

// function getUserById(id) {
//   return data.users.find((u) => u.id === id) || null;
// }

// function createUser({ email, passwordHash }) {
//   const user = {
//     id: newId(),
//     email: String(email).trim().toLowerCase(),
//     passwordHash,
//     qumsQid: '',
//     qumsPasswordEncrypted: '',
//     qumsSessionPath: '',
//     telegramLinkCode: '',
//     telegramChatId: '',
//     createdAt: new Date().toISOString(),
//   };
//   data.users.push(user);
//   persist();
//   return user;
// }

// function updateUser(id, patch) {
//   const user = getUserById(id);
//   if (user) Object.assign(user, patch);
//   persist();
//   return getUserById(id);
// }

// function sessionPathFor(userId) {
//   return path.join(QUMS_SESSION_DIR, `${userId}.json`);
// }

// // ---- forgot-password tokens ----
// function tokenHash(token) {
//   return crypto.createHash('sha256').update(String(token)).digest('hex');
// }

// function storeResetToken(email, token) {
//   // ek email pe ek hi active token
//   data.resets = data.resets.filter((r) => r.email !== String(email).toLowerCase());
//   data.resets.push({
//     email: String(email).toLowerCase(),
//     tokenHash: tokenHash(token),
//     expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour
//   });
//   persist();
// }

// function consumeResetToken(token) {
//   const h = tokenHash(token);
//   const rec = data.resets.find((r) => r.tokenHash === h) || null;
//   if (!rec) return null;
//   data.resets = data.resets.filter((r) => r.tokenHash !== h);
//   persist();
//   if (Date.now() > rec.expiresAt) return null;
//   return getUserByEmail(rec.email);
// }

// // ---- known attendance (month-register dedupe; "known_attendance" table) ----
// // Per-user records: { key, date, subjectCode, subject, status, teacher,
// //                     lectureIndex, lecturesThatDay, seenAt }
// const KNOWN_ATTENDANCE_CAP = 5000; // per user — purani entries chhod do

// function knownAttendanceEntry(userId) {
//   return data.knownAttendance.find((k) => k.userId === userId) || null;
// }

// function listKnownAttendance(userId) {
//   const entry = knownAttendanceEntry(userId);
//   return entry ? entry.records.slice() : [];
// }

// function addKnownAttendance(userId, records) {
//   let entry = knownAttendanceEntry(userId);
//   if (!entry) {
//     entry = { userId, records: [] };
//     data.knownAttendance.push(entry);
//   }
//   const seen = new Set(entry.records.map((r) => r.key));
//   let added = 0;
//   for (const rec of records || []) {
//     if (!rec || !rec.key || seen.has(rec.key)) continue;
//     entry.records.push({ ...rec, seenAt: new Date().toISOString() });
//     seen.add(rec.key);
//     added += 1;
//   }
//   if (entry.records.length > KNOWN_ATTENDANCE_CAP) {
//     entry.records = entry.records.slice(-KNOWN_ATTENDANCE_CAP);
//   }
//   if (added) persist();
//   return added;
// }

// function removeKnownAttendance(userId, keys) {
//   const entry = knownAttendanceEntry(userId);
//   if (!entry) return 0;
//   const drop = new Set(Array.isArray(keys) ? keys : [keys]);
//   const before = entry.records.length;
//   entry.records = entry.records.filter((r) => !drop.has(r.key));
//   const removed = before - entry.records.length;
//   if (removed) persist();
//   return removed;
// }

// // ---- weekly schedule cache (7-day TTL; PK: userId + dayOfWeek + period) ----
// // Spec: student ka weekly timetable fixed/repeating hota hai. Pehle hafte har
// // din live scrape se cache build hoti hai; uske baad morning message mostly
// // cache se fast banta hai, aur har 7 din me ek baar auto-refresh ho jata hai.
// const WEEKLY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// function weeklyRowsFor(userId, dayOfWeek) {
//   return data.weeklySchedule.filter(
//     (r) => r.userId === userId && r.dayOfWeek === dayOfWeek
//   );
// }

// /** rows: [{ period, subject, subjectCode, teacher, room }] — upsert (PK per period). */
// function upsertWeeklySchedule(userId, dayOfWeek, rows) {
//   let changed = false;
//   for (const row of rows || []) {
//     if (!row || !row.period) continue;
//     const hit = data.weeklySchedule.find(
//       (r) => r.userId === userId && r.dayOfWeek === dayOfWeek && r.period === row.period
//     );
//     const patch = {
//       subject: row.subject || '',
//       subjectCode: row.subjectCode || '',
//       teacher: row.teacher || '',
//       room: row.room || '',
//       lastUpdated: new Date().toISOString(),
//     };
//     if (hit) {
//       Object.assign(hit, patch);
//     } else {
//       data.weeklySchedule.push({ userId, dayOfWeek, period: row.period, ...patch });
//     }
//     changed = true;
//   }
//   if (changed) persist();
//   return (rows || []).length;
// }

/**
 * Cached rows for (userId, dayOfWeek). Returns:
 *   { fresh: Boolean, rows: [{ period, subject, subjectCode, teacher, room }] }
 * fresh = entries exist AND sab se nayi lastUpdated 7 din se purani nahi.
 */
// function getWeeklySchedule(userId, dayOfWeek) {
//   const rows = weeklyRowsFor(userId, dayOfWeek);
//   if (!rows.length) return { fresh: false, rows: [] };
//   const newest = Math.max(...rows.map((r) => Date.parse(r.lastUpdated) || 0));
//   const fresh = Date.now() - newest < WEEKLY_TTL_MS;
//   return {
//     fresh,
//     rows: rows.map((r) => ({
//       period: r.period,
//       duration: '',
//       subject: r.subject,
//       subjectCode: r.subjectCode,
//       teacher: r.teacher,
//       room: r.room,
//     })),
//   };
// }

// /** Force-refresh ke liye: (userId[, dayOfWeek]) ki cached entries delete. */
// function clearWeeklySchedule(userId, dayOfWeek) {
//   const before = data.weeklySchedule.length;
//   data.weeklySchedule = data.weeklySchedule.filter(
//     (r) => !(r.userId === userId && (dayOfWeek === undefined || r.dayOfWeek === dayOfWeek))
//   );
//   const removed = before - data.weeklySchedule.length;
//   if (removed) persist();
//   return removed;
// }

// // ---- telegram linking (deep-link flow; purane WhatsApp channel ki jagah) ----
// // users schema add: telegramLinkCode (dashboard->bot deep-link payload),
// //                   telegramChatId (/start par save hota hai)

// function telegramLinkCodeFor(userId) {
//   const user = getUserById(userId);
//   if (!user) return null;
//   if (!user.telegramLinkCode) {
//     user.telegramLinkCode = crypto.randomBytes(6).toString('hex'); // 12 hex chars
//     persist();
//   }
//   return user.telegramLinkCode;
// }

// function getUserByTelegramLinkCode(code) {
//   const c = String(code || '').trim();
//   if (!c) return null;
//   return data.users.find((u) => u.telegramLinkCode && u.telegramLinkCode === c) || null;
// }

// function getUserByTelegramChatId(chatId) {
//   const c = String(chatId || '').trim();
//   if (!c) return null;
//   return data.users.find((u) => u.telegramChatId && String(u.telegramChatId) === c) || null;
// }

// function setTelegramChatId(userId, chatId) {
//   const user = getUserById(userId);
//   if (!user) return null;
//   user.telegramChatId = String(chatId).trim();
//   persist();
//   return user;
// }

/**
 * PRIVACY GUARANTEE: ek Telegram chat sirf EK account se linked rahegi.
 * Naya /start <code> same chat pe aaye to dusre users ka is chat pe koi
 * binding khatam — warna purane user ke updates bhi isi chat pe aa sakte the.
 */
// function clearTelegramChatForChat(chatId, exceptUserId) {
//   const c = String(chatId || '').trim();
//   if (!c) return 0;
//   let cleared = 0;
//   for (const u of data.users) {
//     if (u.id !== exceptUserId && u.telegramChatId && String(u.telegramChatId) === c) {
//       u.telegramChatId = '';
//       cleared += 1;
//     }
//   }
//   if (cleared) persist();
//   return cleared;
// }

// function clearTelegramChatId(userId) {
//   const user = getUserById(userId);
//   if (!user) return null;
//   user.telegramChatId = '';
//   persist();
//   return user;
// }

// /** Test/cleanup helper — user row delete (cascade-ish: knownAttendance entry bhi). */
// function deleteUser(userId) {
//   const before = data.users.length;
//   data.users = data.users.filter((u) => u.id !== userId);
//   data.knownAttendance = data.knownAttendance.filter((k) => k.userId !== userId);
//   const removed = before - data.users.length;
//   if (removed) persist();
//   return removed;
// }

// module.exports = {
//   DB_FILE,
//   QUMS_SESSION_DIR,
//   hasUsers,
//   allUsers,
//   getUserByEmail,
//   getUserById,
//   createUser,
//   updateUser,
//   deleteUser,
//   sessionPathFor,
//   storeResetToken,
//   consumeResetToken,
//   listKnownAttendance,
//   addKnownAttendance,
//   removeKnownAttendance,
//   upsertWeeklySchedule,
//   getWeeklySchedule,
//   clearWeeklySchedule,
//   telegramLinkCodeFor,
//   getUserByTelegramLinkCode,
//   getUserByTelegramChatId,
//   setTelegramChatId,
//   clearTelegramChatId,
//   clearTelegramChatForChat,
// };


/**
 * App database — PostgreSQL in production, JSON fallback for local dev.
 * DATABASE_URL present => PostgreSQL. Otherwise data/db.json is used.
 *
 * Tables: users, resets, known_attendance, weekly_schedule.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DB_FILE = path.join(__dirname, '..', 'data', 'db.json');
const QUMS_SESSION_DIR = path.join(__dirname, '..', 'data', 'qums-sessions');
const USE_PG = Boolean(process.env.DATABASE_URL);

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
fs.mkdirSync(QUMS_SESSION_DIR, { recursive: true });

let pool = null;
let initPromise = null;
let data = { users: [], resets: [], knownAttendance: [], weeklySchedule: [] };

if (!USE_PG) {
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    data = {
      users: raw.users || [],
      resets: raw.resets || [],
      knownAttendance: raw.knownAttendance || [],
      weeklySchedule: raw.weeklySchedule || [],
    };
  } catch {}

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
  if (sessionPathsFixed) persistJson();
}

function persistJson() {
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function newId() { return crypto.randomBytes(8).toString('hex'); }
function sessionPathFor(userId) { return path.join(QUMS_SESSION_DIR, `${userId}.json`); }

async function init() {
  if (!USE_PG) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        qums_qid TEXT DEFAULT '',
        qums_password_encrypted TEXT DEFAULT '',
        qums_session_path TEXT DEFAULT '',
        telegram_link_code TEXT DEFAULT '',
        telegram_chat_id TEXT DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS resets (
        email TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL,
        expires_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS known_attendance (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        records JSONB NOT NULL DEFAULT '[]'::jsonb
      );
      CREATE TABLE IF NOT EXISTS weekly_schedule (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        day_of_week INTEGER NOT NULL,
        period TEXT NOT NULL,
        subject TEXT DEFAULT '',
        subject_code TEXT DEFAULT '',
        teacher TEXT DEFAULT '',
        room TEXT DEFAULT '',
        last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, day_of_week, period)
      );
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_weekly_user_day ON weekly_schedule(user_id, day_of_week);
    `);

    // One-time local JSON -> PostgreSQL migration. On Render, db.json normally
    // does not exist, so users register normally into PostgreSQL.
    if (fs.existsSync(DB_FILE)) {
      const count = await pool.query('SELECT COUNT(*)::int AS n FROM users');
      if (count.rows[0].n === 0) {
        try {
          const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
          for (const u of raw.users || []) {
            await pool.query(
              `INSERT INTO users
               (id,email,password_hash,qums_qid,qums_password_encrypted,qums_session_path,telegram_link_code,telegram_chat_id,created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
               ON CONFLICT (email) DO NOTHING`,
              [u.id, u.email, u.passwordHash, u.qumsQid || '', u.qumsPasswordEncrypted || '', u.qumsSessionPath ? sessionPathFor(u.id) : '', u.telegramLinkCode || '', u.telegramChatId || '', u.createdAt || new Date().toISOString()]
            );
          }
          for (const k of raw.knownAttendance || []) {
            await pool.query(`INSERT INTO known_attendance(user_id,records) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET records=EXCLUDED.records`, [k.userId, JSON.stringify(k.records || [])]);
          }
          for (const r of raw.weeklySchedule || []) {
            await pool.query(`INSERT INTO weekly_schedule(user_id,day_of_week,period,subject,subject_code,teacher,room,last_updated) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, [r.userId, r.dayOfWeek, r.period, r.subject || '', r.subjectCode || '', r.teacher || '', r.room || '', r.lastUpdated || new Date().toISOString()]);
          }
        } catch (e) {
          console.error('[db] JSON migration warning:', e.message);
        }
      }
    }
  })();
  await initPromise;
}

async function hasUsers() {
  if (!USE_PG) return data.users.length > 0;
  await init();
  const r = await pool.query('SELECT EXISTS(SELECT 1 FROM users) AS exists');
  return r.rows[0].exists;
}

async function allUsers() {
  if (!USE_PG) return data.users.slice();
  await init();
  const r = await pool.query('SELECT * FROM users ORDER BY created_at');
  return r.rows.map(fromUserRow);
}

function fromUserRow(r) {
  return {
    id: r.id, email: r.email, passwordHash: r.password_hash,
    qumsQid: r.qums_qid || '', qumsPasswordEncrypted: r.qums_password_encrypted || '',
    qumsSessionPath: r.qums_session_path || '', telegramLinkCode: r.telegram_link_code || '',
    telegramChatId: r.telegram_chat_id || '', createdAt: r.created_at ? new Date(r.created_at).toISOString() : ''
  };
}

async function getUserByEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!USE_PG) return data.users.find((u) => u.email === e) || null;
  await init();
  const r = await pool.query('SELECT * FROM users WHERE email=$1 LIMIT 1', [e]);
  return r.rows[0] ? fromUserRow(r.rows[0]) : null;
}

async function getUserById(id) {
  if (!USE_PG) return data.users.find((u) => u.id === id) || null;
  await init();
  const r = await pool.query('SELECT * FROM users WHERE id=$1 LIMIT 1', [id]);
  return r.rows[0] ? fromUserRow(r.rows[0]) : null;
}

async function createUser({ email, passwordHash }) {
  const user = { id: newId(), email: String(email).trim().toLowerCase(), passwordHash, qumsQid: '', qumsPasswordEncrypted: '', qumsSessionPath: '', telegramLinkCode: '', telegramChatId: '', createdAt: new Date().toISOString() };
  if (!USE_PG) { data.users.push(user); persistJson(); return user; }
  await init();
  const r = await pool.query(`INSERT INTO users(id,email,password_hash,created_at) VALUES($1,$2,$3,$4) RETURNING *`, [user.id,user.email,user.passwordHash,user.createdAt]);
  return fromUserRow(r.rows[0]);
}

async function updateUser(id, patch) {
  const user = await getUserById(id);
  if (!user) return null;
  const merged = { ...user, ...patch };
  if (!USE_PG) { Object.assign(user, patch); persistJson(); return user; }
  await init();
  const r = await pool.query(`UPDATE users SET email=$2,password_hash=$3,qums_qid=$4,qums_password_encrypted=$5,qums_session_path=$6,telegram_link_code=$7,telegram_chat_id=$8 WHERE id=$1 RETURNING *`, [id, merged.email, merged.passwordHash, merged.qumsQid || '', merged.qumsPasswordEncrypted || '', merged.qumsSessionPath || '', merged.telegramLinkCode || '', merged.telegramChatId || '']);
  return fromUserRow(r.rows[0]);
}

async function deleteUser(userId) {
  if (!USE_PG) {
    const before = data.users.length;
    data.users = data.users.filter((u) => u.id !== userId);
    data.knownAttendance = data.knownAttendance.filter((k) => k.userId !== userId);
    if (before !== data.users.length) persistJson();
    return before - data.users.length;
  }
  await init();
  const r = await pool.query('DELETE FROM users WHERE id=$1', [userId]);
  return r.rowCount;
}

function tokenHash(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }

async function storeResetToken(email, token) {
  const e = String(email).toLowerCase();
  const expiresAt = Date.now() + 60 * 60 * 1000;
  if (!USE_PG) {
    data.resets = data.resets.filter((r) => r.email !== e);
    data.resets.push({ email: e, tokenHash: tokenHash(token), expiresAt }); persistJson(); return;
  }
  await init();
  await pool.query(`INSERT INTO resets(email,token_hash,expires_at) VALUES($1,$2,$3) ON CONFLICT(email) DO UPDATE SET token_hash=EXCLUDED.token_hash,expires_at=EXCLUDED.expires_at`, [e, tokenHash(token), expiresAt]);
}

async function consumeResetToken(token) {
  const h = tokenHash(token);
  if (!USE_PG) {
    const rec = data.resets.find((r) => r.tokenHash === h) || null;
    if (!rec) return null;
    data.resets = data.resets.filter((r) => r.tokenHash !== h); persistJson();
    if (Date.now() > rec.expiresAt) return null;
    return getUserByEmail(rec.email);
  }
  await init();
  const r = await pool.query('SELECT email,expires_at FROM resets WHERE token_hash=$1 LIMIT 1', [h]);
  if (!r.rows[0]) return null;
  await pool.query('DELETE FROM resets WHERE token_hash=$1', [h]);
  if (Date.now() > Number(r.rows[0].expires_at)) return null;
  return getUserByEmail(r.rows[0].email);
}

async function listKnownAttendance(userId) {
  if (!USE_PG) { const e=data.knownAttendance.find(k=>k.userId===userId); return e ? e.records.slice() : []; }
  await init(); const r=await pool.query('SELECT records FROM known_attendance WHERE user_id=$1',[userId]); return r.rows[0] ? r.rows[0].records : [];
}

async function addKnownAttendance(userId, records) {
  const current = await listKnownAttendance(userId); const seen=new Set(current.map(r=>r.key)); let added=0;
  for (const rec of records || []) { if(!rec||!rec.key||seen.has(rec.key)) continue; current.push({...rec,seenAt:new Date().toISOString()}); seen.add(rec.key); added++; }
  const trimmed=current.slice(-5000);
  if (!USE_PG) { let e=data.knownAttendance.find(k=>k.userId===userId); if(!e){e={userId,records:[]};data.knownAttendance.push(e);} e.records=trimmed; if(added)persistJson(); return added; }
  await init(); await pool.query(`INSERT INTO known_attendance(user_id,records) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET records=EXCLUDED.records`,[userId,JSON.stringify(trimmed)]); return added;
}

async function removeKnownAttendance(userId, keys) {
  const drop=new Set(Array.isArray(keys)?keys:[keys]); const current=await listKnownAttendance(userId); const next=current.filter(r=>!drop.has(r.key)); const removed=current.length-next.length;
  if(!removed) return 0;
  if(!USE_PG){let e=data.knownAttendance.find(k=>k.userId===userId);if(e){e.records=next;persistJson();}return removed;}
  await init();await pool.query('UPDATE known_attendance SET records=$2 WHERE user_id=$1',[userId,JSON.stringify(next)]);return removed;
}

async function upsertWeeklySchedule(userId, dayOfWeek, rows) {
  if (!USE_PG) {
    for(const row of rows||[]){if(!row||!row.period)continue;const hit=data.weeklySchedule.find(r=>r.userId===userId&&r.dayOfWeek===dayOfWeek&&r.period===row.period);const patch={subject:row.subject||'',subjectCode:row.subjectCode||'',teacher:row.teacher||'',room:row.room||'',lastUpdated:new Date().toISOString()};if(hit)Object.assign(hit,patch);else data.weeklySchedule.push({userId,dayOfWeek,period:row.period,...patch});} persistJson(); return (rows||[]).length;
  }
  await init(); for(const row of rows||[]){if(!row||!row.period)continue;await pool.query(`INSERT INTO weekly_schedule(user_id,day_of_week,period,subject,subject_code,teacher,room,last_updated) VALUES($1,$2,$3,$4,$5,$6,$7,NOW()) ON CONFLICT(user_id,day_of_week,period) DO UPDATE SET subject=EXCLUDED.subject,subject_code=EXCLUDED.subject_code,teacher=EXCLUDED.teacher,room=EXCLUDED.room,last_updated=NOW()`,[userId,dayOfWeek,row.period,row.subject||'',row.subjectCode||'',row.teacher||'',row.room||'']);} return (rows||[]).length;
}

async function getWeeklySchedule(userId, dayOfWeek) {
  if(!USE_PG){const rows=data.weeklySchedule.filter(r=>r.userId===userId&&r.dayOfWeek===dayOfWeek);if(!rows.length)return{fresh:false,rows:[]};const newest=Math.max(...rows.map(r=>Date.parse(r.lastUpdated)||0));return{fresh:Date.now()-newest<7*24*60*60*1000,rows:rows.map(r=>({period:r.period,duration:'',subject:r.subject,subjectCode:r.subjectCode,teacher:r.teacher,room:r.room}))};}
  await init();const r=await pool.query('SELECT * FROM weekly_schedule WHERE user_id=$1 AND day_of_week=$2 ORDER BY period',[userId,dayOfWeek]);if(!r.rows.length)return{fresh:false,rows:[]};const newest=Math.max(...r.rows.map(x=>new Date(x.last_updated).getTime()));return{fresh:Date.now()-newest<7*24*60*60*1000,rows:r.rows.map(x=>({period:x.period,duration:'',subject:x.subject,subjectCode:x.subject_code,teacher:x.teacher,room:x.room}))};
}

async function clearWeeklySchedule(userId, dayOfWeek) {
  if(!USE_PG){const before=data.weeklySchedule.length;data.weeklySchedule=data.weeklySchedule.filter(r=>!(r.userId===userId&&(dayOfWeek===undefined||r.dayOfWeek===dayOfWeek)));const n=before-data.weeklySchedule.length;if(n)persistJson();return n;}
  await init();const r=dayOfWeek===undefined?await pool.query('DELETE FROM weekly_schedule WHERE user_id=$1',[userId]):await pool.query('DELETE FROM weekly_schedule WHERE user_id=$1 AND day_of_week=$2',[userId,dayOfWeek]);return r.rowCount;
}

async function telegramLinkCodeFor(userId){const user=await getUserById(userId);if(!user)return null;if(user.telegramLinkCode)return user.telegramLinkCode;const code=crypto.randomBytes(6).toString('hex');await updateUser(userId,{telegramLinkCode:code});return code;}
async function getUserByTelegramLinkCode(code){const c=String(code||'').trim();if(!c)return null;if(!USE_PG){return data.users.find(u=>u.telegramLinkCode&&u.telegramLinkCode===c)||null;}await init();const r=await pool.query('SELECT * FROM users WHERE telegram_link_code=$1 LIMIT 1',[c]);return r.rows[0]?fromUserRow(r.rows[0]):null;}
async function getUserByTelegramChatId(chatId){const c=String(chatId||'').trim();if(!c)return null;if(!USE_PG)return data.users.find(u=>u.telegramChatId&&String(u.telegramChatId)===c)||null;await init();const r=await pool.query('SELECT * FROM users WHERE telegram_chat_id=$1 LIMIT 1',[c]);return r.rows[0]?fromUserRow(r.rows[0]):null;}
async function setTelegramChatId(userId,chatId){return updateUser(userId,{telegramChatId:String(chatId).trim()});}
async function clearTelegramChatForChat(chatId,exceptUserId){const c=String(chatId||'').trim();if(!c)return 0;if(!USE_PG){let n=0;for(const u of data.users){if(u.id!==exceptUserId&&u.telegramChatId&&String(u.telegramChatId)===c){u.telegramChatId='';n++;}}if(n)persistJson();return n;}await init();const r=await pool.query('UPDATE users SET telegram_chat_id=\'\' WHERE telegram_chat_id=$1 AND id<>$2',[c,exceptUserId]);return r.rowCount;}
async function clearTelegramChatId(userId){return updateUser(userId,{telegramChatId:''});}

module.exports={
  DB_FILE,QUMS_SESSION_DIR,USE_PG,init,hasUsers,allUsers,getUserByEmail,getUserById,createUser,updateUser,deleteUser,sessionPathFor,
  storeResetToken,consumeResetToken,listKnownAttendance,addKnownAttendance,removeKnownAttendance,upsertWeeklySchedule,getWeeklySchedule,clearWeeklySchedule,
  telegramLinkCodeFor,getUserByTelegramLinkCode,getUserByTelegramChatId,setTelegramChatId,clearTelegramChatForChat,clearTelegramChatId,
};
