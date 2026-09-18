/**
 * Real-time per-class Telegram watcher — MULTI-USER.
 *
 * TWO polling loops chalte hain:
 *
 * 1) TODAY'S ATTENDANCE (fast loop):
 *   - every WATCH_INTERVAL_MINUTES (default 5), but ONLY during college hours
 *     (08:30–17:00 IST)
 *   - for EVERY registered user with a linked QUMS session, the watcher polls
 *     TODAY's periods using that user's own session file
 *   - a period goes from "N.M." (not marked) to P/A when the teacher marks it;
 *     on first sighting the user gets a Telegram alert (teacher + subject +
 *     period + date + marked-you-as), sent TO THE USER'S OWN Telegram chat
 *   - per-user dedupe state: data/notified_periods/<userId>.json
 *     -> duplicates NEVER go out (state marked BEFORE send; rollback on failure)
 *
 * 2) MONTH REGISTER (backdated loop):
 *   - every MONTH_REGISTER_INTERVAL_MINUTES (default 10 — user ko near-real-time
 *     updates chahiye; backdated marking bhi jaldi pakdi jaati hai)
 *   - POST /Web_StudentAcademic/GetMonthRegister { RegID, Month } se current
 *     month ke saare MARKED records (P/A/L) aate hain
 *   - jo record db "known_attendance" me nahi hai => naya (backdated) marking
 *     => Telegram alert: "{Teacher} ne {Date} ko {Subject} ({Code}) ka
 *        attendance mark kiya / Status: ✅/❌"
 *   - teacher Month Register API me NAHI hota -> timetable cross-match
 *     (sirf tab jab pending notifications hon — browser launch bachane ke liye)
 *   - FIRST run bootstrap: poora current month silently seed hota hai (koi
 *     alert-storm nahi); uske baad sirf naye (backdated) records alert karte hain
 *   - dup-guard: college hours ke andar aaj ke marks fast loop (5 min) se aate
 *     hain, month loop unhe skip karta hai; bahar hours (evening) aaj ke naye
 *     marks month loop hi turant alert karta hai
 *
 * Sends user ke APNE Telegram chat pe jaate hain (deep-link se linked —
 * src/telegram.js). Link na ho to sends silently skip hote hain.
 *
 * IMPORTANT: polling only works while the server runs (see README limitations).
 *
 * Standalone:
 *   node src/watcher.js --test          -> simulated cycles, DRY-RUN (no real send)
 *   node src/watcher.js --test --send   -> simulated cycles with REAL Telegram send
 *   node src/watcher.js --now [--force] -> one real cycle now for all users
 *   node src/watcher.js --month-test [--send] -> month-register simulation
 *   node src/watcher.js --month-now     -> one real month-register pass now
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./db');
const {
  scrapeTodaysAttendance,
  scrapeMonthRegister,
  scrapeTimetable,
  getTimetableForDate,
  teacherForRecord,
  roomForRecord,
} = require('./scraper');
const { sendMessage } = require('./telegram');
const { formatAttendanceUpdate, formatBackdatedUpdate, dateLabelIST } = require('./messages');
const { maybeNotifySessionExpired } = require('./alerts');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PER_USER_STATE_DIR = path.join(DATA_DIR, 'notified_periods');
const LEGACY_STATE_FILE = path.join(DATA_DIR, 'notified_periods.json');
const TEST_STATE_FILE = path.join(DATA_DIR, 'notified_periods.test.json');

const COLLEGE_START_HOUR = 8.5; // 08:30 IST
const COLLEGE_END_HOUR = 17; // 17:00 IST

function stateFileFor(userId) {
  return path.join(PER_USER_STATE_DIR, `${userId}.json`);
}

/** Current IST time parts: { date 'YYYY-MM-DD', hourDecimal, hhmm } */
function istNow(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(d);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  const hour = Number(get('hour')) % 24; // some Node versions render midnight as "24"
  const minute = Number(get('minute'));
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour,
    minute,
    hourDecimal: hour + minute / 60,
    hhmm: `${String(hour).padStart(2, '0')}:${get('minute')}`,
  };
}

function isWithinCollegeHours(hourDecimal) {
  return hourDecimal >= COLLEGE_START_HOUR && hourDecimal < COLLEGE_END_HOUR;
}

function loadState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

// Timetable cache (60 min TTL) — room enrichment + teacher cross-match ke liye.
// Har pass pe headless browser launch mehenga hota hai, isliye cache rakhte hain.
const TIMETABLE_TTL_MS = 60 * 60 * 1000;
const timetableCache = new Map(); // userId -> { at, timetable }

async function getTimetableCached(userId, sessionPath, log = console) {
  const hit = timetableCache.get(userId);
  if (hit && Date.now() - hit.at < TIMETABLE_TTL_MS) return hit.timetable;
  try {
    const timetable = await scrapeTimetable({ sessionPath });
    timetableCache.set(userId, { at: Date.now(), timetable });
    return timetable;
  } catch (err) {
    log.log(`[watcher] timetable refresh fail (${err.name}: ${err.message}) — ${hit ? 'stale cache use kar rahe hain' : 'room/teacher enrichment is cycle me skip'}`);
    return hit ? hit.timetable : null;
  }
}

/** aaj ke timetable periods se subjectCode -> room map */
function roomMapFromPeriods(periods) {
  const map = {};
  for (const p of periods || []) {
    if (p.subjectCode && !(p.subjectCode in map)) map[p.subjectCode] = p.room || '';
  }
  return map;
}

/** Pure: which rows need a notification? (marked + not already notified + deduped in-batch) */
function pendingNotifications(rows, notifiedKeys) {
  const seen = new Set(notifiedKeys || []);
  const out = [];
  for (const row of rows || []) {
    if (!row || row.status === 'unmarked') continue;
    if (!row.key || seen.has(row.key)) continue;
    seen.add(row.key); // also dedupes duplicates inside one fetch
    out.push(row);
  }
  return out;
}

/** Per-class Telegram message (teacher + subject + period + date + marked-as). */
function buildUpdateMessage(row, dateLabel = dateLabelIST()) {
  return formatAttendanceUpdate(row, dateLabel);
}

/**
 * One watcher cycle for ONE user: fetch today's rows (that user's session),
 * diff against their notified state, send alerts to THEIR number.
 */
async function runWatcherCycle(opts = {}) {
  const log = opts.log || console;
  const fetchFn = opts.fetchFn || scrapeTodaysAttendance;
  const sendFn = opts.sendFn || ((text) => sendMessage(opts.userId, text));
  const stateFile = opts.stateFile || LEGACY_STATE_FILE;
  const force = !!opts.force;

  const now = istNow();
  if (!force && !isWithinCollegeHours(now.hourDecimal)) {
    return { skipped: true, reason: 'outside-college-hours', at: now.hhmm };
  }

  let rows;
  try {
    rows = await fetchFn();
  } catch (err) {
    if (err.name === 'SessionExpiredError' || err.name === 'NoSessionError') {
      await maybeNotifySessionExpired(log, opts.userId);
    }
    throw err;
  }

  // Room enrichment: aaj ke timetable periods se subjectCode -> room
  if (opts.roomByCode) {
    rows = rows.map((r) => ({ ...r, room: opts.roomByCode[r.subjectCode] || '' }));
  }

  const state = loadState(stateFile);
  const notified = state[now.date] || [];
  const pending = pendingNotifications(rows, notified);

  log.log(
    `[watcher] ${now.hhmm} IST${opts.userEmail ? ` (${opts.userEmail})` : ''} — ${rows.length} periods aaj, ${pending.length} naye marked.`
  );

  const sent = [];
  for (const row of pending) {
    const text = buildUpdateMessage(row);
    // Mark as notified BEFORE sending — guarantees no duplicates even if the
    // process dies mid-send. On failure we roll back so the next cycle retries.
    notified.push(row.key);
    state[now.date] = notified;
    saveState(state, stateFile);
    try {
      if (opts.dryRun) {
        log.log(`[watcher] (dry-run) would send to ${opts.userEmail || 'user'}:\n${text}\n`);
      } else {
        await sendFn(text);
        log.log(`[watcher] 📲 sent: ${row.key} (${row.status}) — ${row.subject}`);
      }
      sent.push({ key: row.key, status: row.status, subject: row.subject });
    } catch (err) {
      state[now.date] = (state[now.date] || []).filter((k) => k !== row.key);
      saveState(state, stateFile);
      log.error(`[watcher] send FAILED for ${row.key}: ${err.message} — next cycle me retry hoga`);
    }
  }

  return { skipped: false, date: now.date, totalPeriods: rows.length, notified: sent };
}

/** One full watcher pass over ALL users with a linked QUMS session. */
async function runWatcherPass(log = console) {
  const users = db.allUsers().filter((u) => u.qumsSessionPath);
  if (!users.length) {
    log.log('[watcher] koi user ka QUMS session linked nahi — pass skip.');
    return { users: 0 };
  }
  log.log(`[watcher] pass started for ${users.length} user(s)...`);
  const results = [];
  for (const user of users) {
    try {
      // eslint-disable-next-line no-await-in-loop
      // eslint-disable-next-line no-await-in-loop
      const timetable = await getTimetableCached(user.id, user.qumsSessionPath, log);
      const roomByCode = timetable ? roomMapFromPeriods(getTimetableForDate(timetable, new Date())) : null;
      const r = await runWatcherCycle({
        log,
        userId: user.id,
        fetchFn: () => scrapeTodaysAttendance({ sessionPath: user.qumsSessionPath }),
        sendFn: (text) => sendMessage(user.id, text),
        stateFile: stateFileFor(user.id),
        roomByCode,
        userEmail: user.email,
      });
      results.push({ email: user.email, ...r });
    } catch (err) {
      log.error(`[watcher] pass failed for ${user.email}: ${err.message}`);
      results.push({ email: user.email, error: err.message });
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 500)); // stagger users — portal load kam
  }
  return { users: users.length, results };
}

// ---------------------------------------------------------------------------
// MONTH REGISTER loop — backdated attendance (dedupe via db known_attendance)
// ---------------------------------------------------------------------------

const MONTH_REGISTER_INTERVAL_MINUTES = Number(process.env.MONTH_REGISTER_INTERVAL_MINUTES) || 10;

/**
 * Pure: kaunse month-register records naye hain?
 * (marked + known me na ho + in-batch dedupe + purane multi-lecture keys
 *  `date-CODE#1` ko group key `date-CODE` me migrate karta hai)
 */
function pendingMonthNotifications(records, knownRecords) {
  const known = new Set();
  for (const r of knownRecords || []) {
    if (!r || !r.key) continue;
    known.add(r.key);
    const hash = r.key.indexOf('#');
    if (hash !== -1) known.add(r.key.slice(0, hash)); // migration: purana per-lecture key -> group key
  }
  const seen = new Set();
  const out = [];
  for (const rec of records || []) {
    if (!rec || rec.status === 'unmarked') continue; // N / empty = not marked
    if (!rec.key || known.has(rec.key) || seen.has(rec.key)) continue;
    seen.add(rec.key);
    out.push(rec);
  }
  return out;
}

/** Backdated alert message (spec format) — messages.formatBackdatedUpdate. */
function buildBackdatedMessage(rec) {
  return formatBackdatedUpdate(rec);
}

/**
 * One month-register cycle for ONE user: fetch current month (that user's
 * session), diff against their db known_attendance, send alerts to THEIR
 * number. First run (known empty) -> bootstrap seed, NO alerts.
 */
async function runMonthRegisterCycle(opts = {}) {
  const log = opts.log || console;
  const sendFn = opts.sendFn || ((text) => sendMessage(opts.userId, text));
  const userId = opts.userId;
  if (!userId) throw new Error('runMonthRegisterCycle: userId required');

  let result;
  try {
    result = await opts.fetchFn();
  } catch (err) {
    if (err.name === 'SessionExpiredError' || err.name === 'NoSessionError') {
      await maybeNotifySessionExpired(log, userId);
    }
    throw err;
  }

  const records = (result.records || []).filter((r) => r.status !== 'unmarked');
  const known = db.listKnownAttendance(userId);
  let pending = pendingMonthNotifications(records, known);

  // Dup-alert guard: college hours ke ANDAR aaj ke marks FAST loop (5 min)
  // handle karta hai — month loop unhe skip karta hai (double alert na ho).
  // Bahar hours (evening/raat) fast loop soya hota hai, to month loop hi aaj
  // ke naye marks alert karta hai — par sirf wo jo fast loop ne din me pehle
  // alert na kar chuka ho (notified_periods se cross-check).
  const todayIst = istNow();
  const inHours = isWithinCollegeHours(todayIst.hourDecimal);
  const fastNotifiedCodes = new Set(
    (loadState(stateFileFor(userId))[todayIst.date] || []).map((k) => k.split('-').slice(1).join('-'))
  );
  pending = pending.filter((rec) => {
    if (rec.date !== todayIst.date) return true; // backdated — hamesha eligible
    if (inHours) return false; // fast loop ki zimmedari
    return !fastNotifiedCodes.has(rec.subjectCode);
  });

  // First run bootstrap: poore month ko silently seed karo — varna pehli
  // cycle me mahine bhar ke purane marks ki alert-storm chali jayegi.
  const bootstrap = !known.length && records.length > 0;
  if (bootstrap) pending = [];

  log.log(
    `[watcher] month-register ${result.year}-${String(result.month).padStart(2, '0')}${opts.userEmail ? ` (${opts.userEmail})` : ''} — ${records.length} marked records, ${pending.length} naye${bootstrap ? ' (BOOTSTRAP seed, koi alert nahi)' : ''}.`
  );

  // Teacher + Room cross-match sirf tab (browser launch mehengi hai)
  if (pending.length && opts.timetableFn) {
    try {
      const timetable = await opts.timetableFn();
      pending = pending.map((rec) => ({
        ...rec,
        teacher: rec.teacher || teacherForRecord(timetable, rec),
        room: rec.room || roomForRecord(timetable, rec),
      }));
    } catch (err) {
      log.log(`[watcher] timetable cross-match fail (${err.name}: ${err.message}) — teacher/room bina hi alert jayega.`);
    }
  }

  const sent = [];
  for (const rec of pending) {
    const text = buildBackdatedMessage(rec);
    // Mark-before-send: duplicates IMPOSSIBLE even if the process dies mid-send.
    db.addKnownAttendance(userId, [rec]);
    try {
      if (opts.dryRun) {
        log.log(`[watcher] (dry-run) would send to ${opts.userEmail || 'user'}:\n${text}\n`);
      } else {
        await sendFn(text);
        log.log(`[watcher] 📲 sent backdated: ${rec.key} (${rec.status}) — ${rec.subjectCode}${rec.teacher ? ` / ${rec.teacher}` : ''}`);
      }
      sent.push({ key: rec.key, status: rec.status, date: rec.date, subjectCode: rec.subjectCode });
    } catch (err) {
      db.removeKnownAttendance(userId, rec.key); // rollback — next cycle retry
      log.error(`[watcher] send FAILED for ${rec.key}: ${err.message} — next cycle me retry hoga`);
    }
  }

  if (bootstrap) db.addKnownAttendance(userId, records);

  return { skipped: false, bootstrap, year: result.year, month: result.month, totalMarked: records.length, notified: sent };
}

/**
 * Task 3 — IMMEDIATE BASELINE (naye/re-setup user ke liye):
 * QUMS setup complete hote hi ye ek baar chalta hai:
 *   - aaj ke MARKED periods (P/A) ko fast-loop dedupe state
 *     (data/notified_periods/<userId>.json) me seed kar deta hai
 *   - N.M. (not-marked) periods ko KAHIN nahi daala — unpe aage teacher mark
 *     kare to alert NORMALLY aayega (usi din, agle cycle ka wait nahi)
 * Isse already-marked periods ka alert-storm nahi hota, aur month-register
 * loop ka apna bootstrap bhi intact rehta hai (pehli baar poora month silently
 * seed hota hai — wahi correct behaviour hai).
 */
async function runBaselineForUser(userId, log = console) {
  const user = db.getUserById(userId);
  if (!user || !user.qumsSessionPath) {
    return { skipped: true, reason: 'qums-session-missing' };
  }
  const rows = await scrapeTodaysAttendance({ sessionPath: user.qumsSessionPath });
  const marked = rows.filter((r) => r.status !== 'unmarked');
  const now = istNow();

  const state = loadState(stateFileFor(userId));
  const todayKeys = state[now.date] || [];
  let seededFast = 0;
  for (const r of marked) {
    if (!todayKeys.includes(r.key)) {
      todayKeys.push(r.key);
      seededFast += 1;
    }
  }
  state[now.date] = todayKeys;
  saveState(state, stateFileFor(userId));

  log.log(
    `[watcher] baseline ${user.email}: ${rows.length} periods aaj, ${marked.length} already-marked -> fast-loop seeded (${seededFast} naye keys). N.M. periods ke alerts normal rahenge.`
  );
  return { skipped: false, totalPeriods: rows.length, marked: marked.length, seededFast };
}

/** One full month-register pass over ALL users with a linked QUMS session. */
async function runMonthRegisterPass(log = console, opts = {}) {
  const users = db.allUsers().filter((u) => u.qumsSessionPath);
  if (!users.length) {
    log.log('[watcher] month-register: koi user ka QUMS session linked nahi — pass skip.');
    return { users: 0 };
  }
  log.log(`[watcher] month-register pass started for ${users.length} user(s)...`);
  const results = [];
  for (const user of users) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await runMonthRegisterCycle({
        log,
        userId: user.id,
        userEmail: user.email,
        dryRun: !!opts.dryRun,
        fetchFn: () => scrapeMonthRegister({ sessionPath: user.qumsSessionPath }),
        timetableFn: () => getTimetableCached(user.id, user.qumsSessionPath, log),
        sendFn: (text) => sendMessage(user.id, text),
      });
      results.push({ email: user.email, ...r });
    } catch (err) {
      log.error(`[watcher] month-register pass failed for ${user.email}: ${err.message}`);
      results.push({ email: user.email, error: err.message });
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 500)); // stagger users — portal load kam
  }
  return { users: users.length, results };
}

/** Arm the month-register (backdated) loop — startWatcher ke saath chalta hai. */
function startMonthRegisterWatcher(log = console) {
  const minutes = MONTH_REGISTER_INTERVAL_MINUTES;
  log.log(`[watcher] month-register loop armed — har ${minutes} min, current month, saare users`);
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await runMonthRegisterPass(log);
    } catch (err) {
      log.error(`[watcher] month-register pass failed: ${err.name || 'Error'}: ${err.message}`);
    } finally {
      busy = false;
    }
  }, minutes * 60 * 1000);
  return timer;
}

/** Arm the continuous multi-user watcher (called from server.js). */
function startWatcher(log = console) {
  const minutes = Number(process.env.WATCH_INTERVAL_MINUTES) || 5;
  log.log(`[watcher] armed — har ${minutes} min, college hours 08:30\u201317:00 IST, saare registered users`);
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return; // previous pass still running — skip this tick
    busy = true;
    try {
      const now = istNow();
      if (isWithinCollegeHours(now.hourDecimal)) {
        await runWatcherPass(log);
      } else {
        log.log(`[watcher] ${now.hhmm} IST — college hours ke bahar, pass skip.`);
      }
    } catch (err) {
      log.error(`[watcher] pass failed: ${err.name || 'Error'}: ${err.message}`);
    } finally {
      busy = false;
    }
  }, minutes * 60 * 1000);
  return timer;
}

// ---------------------------------------------------------------------------
// --test harness: simulated schedule. P1 stays N.M., P2 gets marked after the
// first poll, P3 is pre-seeded as ALREADY notified — proves dedupe end-to-end.
// Dry-run by default (--send for real Telegram).
if (require.main === module) {
  const args = process.argv.slice(2);
  const realSend = args.includes('--send');
  const isNow = args.includes('--now');
  const force = args.includes('--force');

  (async () => {
    if (args.includes('--test')) {
      const virtual = [
        { Period: 'P1', Duration: '08:55-09:50', subject: 'Robotic Industry 4.0', SubjectCode: 'MT3015', Employeename: 'ANKUR JAIN', Attend: 'N.M.' },
        { Period: 'P2', Duration: '09:55-10:50', subject: 'Design and Analysis of Algorithm', SubjectCode: 'CS35303', Employeename: 'DR. R K RAO', Attend: 'N.M.' },
        { Period: 'P3', Duration: '10:55-11:50', subject: 'Foundation of Cloud Computing', SubjectCode: 'CS35304', Employeename: 'PROF. MEHRA', Attend: 'P' },
      ];
      const now = istNow();
      saveState({ [now.date]: ['P3-CS35304'] }, TEST_STATE_FILE);

      let pollCount = 0;
      const fetchFn = async () => {
        pollCount += 1;
        if (pollCount >= 2) virtual[1].Attend = 'P'; // teacher marks P2 after cycle 1
        // map exactly like the real scraper does (row -> {status, key, ...})
        return virtual.map((r) => ({
          period: r.Period,
          duration: r.Duration,
          subject: r.subject,
          subjectCode: r.SubjectCode,
          employee: r.Employeename,
          attendance: r.Attend,
          status: r.Attend.replace(/\./g, '').toUpperCase().includes('P') ? 'present' : r.Attend.replace(/\./g, '').toUpperCase().includes('A') ? 'absent' : r.Attend.trim() ? 'other' : 'unmarked',
          key: `${r.Period}-${r.SubjectCode}`,
        }));
      };
      const sendFn = async (text) => {
        if (!realSend) {
          console.log(`[watcher] (dry-run) would send:\n${text}\n`);
          return text;
        }
        const realUser = db.allUsers().find((u) => u.telegramChatId) || db.allUsers()[0];
        if (!realUser) throw new Error('Koi registered user nahi — pehle /register karo.');
        return sendMessage(realUser.id, text);
      };

      console.log(`=== WATCHER TEST (3 simulated cycles, ${realSend ? 'REAL Telegram send' : 'DRY-RUN'}) ===`);
      for (let i = 1; i <= 3; i++) {
        console.log(`--- cycle ${i} ---`);
        // eslint-disable-next-line no-await-in-loop
        const r = await runWatcherCycle({ fetchFn, sendFn, stateFile: TEST_STATE_FILE, force: true, dryRun: !realSend });
        console.log(`   result: ${JSON.stringify((r.notified || []).map((n) => n.key))}\n`);
      }
      console.log('Expected: cycle 1 -> [] (sab N.M., P3 already notified); cycle 2 -> [P2-CS35303]; cycle 3 -> [] (duplicate block).');
      process.exit(0);
    }

    if (isNow) {
      const r = await runWatcherPass();
      console.log(`[watcher] pass result: ${JSON.stringify(r).slice(0, 500)}`);
      process.exit(0);
    }

    // ---- month-register: simulation (--month-test) / one real pass (--month-now) ----
    if (args.includes('--month-test')) {
      const users = db.allUsers().filter((u) => u.qumsSessionPath);
      if (!users.length) {
        console.error('[x] koi registered user with QUMS session nahi — pehle web dashboard se QUMS link karo.');
        process.exit(1);
      }
      const user = users[0];
      console.log(`=== MONTH REGISTER TEST (${realSend ? 'REAL send' : 'DRY-RUN'}) — user ${user.email} ===`);
      let cycle = 0;
      const mkRec = (date, code, subject, statusRaw, teacher) => ({
        date,
        day: Number(date.slice(-2)),
        subjectCode: code,
        subject,
        statusRaw,
        status: statusRaw === 'P' ? 'present' : statusRaw === 'A' ? 'absent' : 'other',
        teacher: teacher || '',
        lectureIndex: null,
        lecturesThatDay: 1,
        key: `${date}-${code}`,
      });
      let virtual = [
        mkRec('2026-09-10', 'CS35303', 'Design and Analysis of Algorithm', 'P', 'RAJ KUMAR'),
        mkRec('2026-09-12', 'CS35365', 'Scala for Data Science', 'A', 'BHANU PARTAP'),
      ];
      const fetchFn = async () => {
        cycle += 1;
        if (cycle >= 2) {
          // cycle 2: teacher marks ek NAYA backdated record (12 Sep ko DSA)
          virtual = [...virtual, mkRec('2026-09-11', 'CS35304', 'Foundation of Cloud Computing', 'P', 'PROF. MEHRA')];
        }
        return { year: 2026, month: 9, records: virtual, summary: null };
      };
      const sendFn = async (text) => {
        if (!realSend) {
          console.log(`[watcher] (dry-run) would send:\n${text}\n`);
          return text;
        }
        if (!user.telegramChatId) {
          throw new Error('Is user ka Telegram linked nahi hai — dashboard se Connect Telegram karo, ya --send ke bina dry-run chalao.');
        }
        return sendMessage(user.id, text);
      };
      const cycleOpts = {
        log: console,
        userId: 'month-test-dummy', // real user ka known_attendance pollute na ho
        userEmail: user.email + ' (TEST)',
        fetchFn,
        timetableFn: async () => ({ days: [] }), // simulated timetable (teacher pre-set)
        sendFn,
      };
      for (let i = 1; i <= 3; i++) {
        console.log(`--- month cycle ${i} ---`);
        // eslint-disable-next-line no-await-in-loop
        const r = await runMonthRegisterCycle(cycleOpts);
        console.log(`   notified: ${JSON.stringify((r.notified || []).map((n) => n.key))}\n`);
      }
      console.log('Expected: cycle 1 -> [] (BOOTSTRAP seed, no alerts), cycle 2 -> [2026-09-11-CS35304]');
      console.log('(naya backdated record), cycle 3 -> [] (duplicate block).');
      process.exit(0);
    }

    if (args.includes('--month-now')) {
      const r = await runMonthRegisterPass(console, { dryRun: args.includes('--dry') });
      console.log(`[watcher] month-register pass result: ${JSON.stringify(r).slice(0, 800)}`);
      process.exit(0);
    }

    startWatcher();
    console.log('[watcher] running. Ctrl+C to stop.');
  })().catch((err) => {
    console.error(`[x] ${err.name || 'Error'}: ${err.message}`);
    if (err.hint) console.error(`    hint: ${err.hint}`);
    process.exit(1);
  });
}

module.exports = {
  startWatcher,
  startMonthRegisterWatcher,
  runWatcherCycle,
  runWatcherPass,
  runMonthRegisterCycle,
  runMonthRegisterPass,
  runBaselineForUser,
  pendingNotifications,
  pendingMonthNotifications,
  buildUpdateMessage,
  buildBackdatedMessage,
  MONTH_REGISTER_INTERVAL_MINUTES,
  istNow,
  isWithinCollegeHours,
  stateFileFor,
  loadState,
  saveState,
  COLLEGE_START_HOUR,
  COLLEGE_END_HOUR,
};
