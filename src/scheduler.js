/**
 * Scheduler — MULTI-USER jobs, both in IST (Asia/Kolkata):
 *   08:30 IST  morning schedule   -> aaj ki saari classes (time + room + teacher)
 *   21:00 IST  daily summary      -> attendance + 75% guidance per subject
 *
 * Both iterate every registered user with a linked QUMS session and send to
 * THEIR OWN Telegram chat (deep-link se linked — src/telegram.js), using THEIR
 * OWN decrypted QUMS credentials + session file. Per-user errors never crash
 * the loop; expired sessions trigger a Telegram alert to that user.
 *
 * Standalone:
 *   node src/scheduler.js --now            -> daily summary job abhi (all users)
 *   node src/scheduler.js --now --morning  -> morning schedule job abhi (all users)
 *   node src/scheduler.js                  -> keep only the cron loop alive
 */
require('dotenv').config();
const cron = require('node-cron');
const db = require('./db');
const { scrapeAttendance, getTodaysScheduleWithRoom } = require('./scraper');
const { analyzeAttendance } = require('./calculator');
const { sendMessage } = require('./telegram');
const { formatMorningSchedule, formatAttendanceMessage } = require('./messages');
const { maybeNotifySessionExpired } = require('./alerts');

const SUMMARY_CRON = '0 21 * * *'; // 9:00 PM every day
const MORNING_CRON = '30 8 * * *'; // 8:30 AM every day (pehli class 9:00 se pehle dekhne ka time)
const TIMEZONE = 'Asia/Kolkata';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function activeUsers() {
  return (await db.allUsers()).filter((u) => u.qumsSessionPath);
}

/** Roz 21:00 — per-user attendance summary + 75% guidance. */
async function runDailySummaryJob(log = console) {
  const users = await activeUsers();
  log.log(`[scheduler] 9 PM summary started for ${users.length} user(s).`);
  let ok = 0;
  for (const user of users) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const subjects = await scrapeAttendance({ sessionPath: user.qumsSessionPath });
      const analysis = analyzeAttendance(subjects);
      // eslint-disable-next-line no-await-in-loop
      const sent = await sendMessage(user.id, formatAttendanceMessage(analysis));
      if (!sent) throw new Error('Telegram linked nahi hai — dashboard se Connect Telegram karo.');
      ok += 1;
      log.log(`[scheduler] 📲 summary sent -> ${user.email}`);
    } catch (err) {
      log.error(`[scheduler] summary FAILED for ${user.email}: ${err.message}`);
      if (err.name === 'SessionExpiredError' || err.name === 'NoSessionError') {
        // eslint-disable-next-line no-await-in-loop
        await maybeNotifySessionExpired(log, user.id);
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(500); // stagger users
  }
  log.log(`[scheduler] 9 PM summary done: ${ok}/${users.length} sent.`);
  return { sent: ok, total: users.length };
}

/**
 * Morning schedule text — Task 2 (weekly cache) logic:
 *   1. weekly_schedule_cache me aaj ke dayOfWeek ki FRESH (<=7 din purani)
 *      entries hain -> seedha cache se message (fast, koi scrape nahi)
 *   2. cache missing/stale -> live merge (Today's Attendance + Timetable room)
 *      -> message banao -> cache turant upsert
 * forceRefresh=true -> cache skip + live merge (dashboard "Refresh Schedule").
 */
async function getMorningScheduleText(user, { forceRefresh = false, log = console } = {}) {
  const dow = new Date().getDay();
  if (!forceRefresh) {
    const cached = await db.getWeeklySchedule(user.id, dow);
    if (cached.fresh) {
      log.log(`[scheduler] ${user.email}: weekly cache HIT (dow=${dow}, ${cached.rows.length} periods) — live scrape skip.`);
      return {
        text: formatMorningSchedule(cached.rows),
        mode: cached.rows.length ? 'weekly-cache' : 'weekly-cache-empty',
      };
    }
    log.log(`[scheduler] ${user.email}: weekly cache MISS/STALE (dow=${dow}) — live merge chalega.`);
  }
  const rows = await getTodaysScheduleWithRoom(user.id); // live merge + cache upsert
  return {
    text: formatMorningSchedule(rows),
    mode: forceRefresh ? 'live-merge (forced)' : 'live-merge',
  };
}

/** Roz 08:30 — per-user aaj ki classes (subah 8:30 baje: kon si class, kis time, kaunse room). */
async function runMorningScheduleJob(log = console) {
  const users = await activeUsers();
  log.log(`[scheduler] 8:30 AM morning schedule started for ${users.length} user(s).`);
  let ok = 0;
  for (const user of users) {
    try {
      const { text, mode } = await getMorningScheduleText(user, { log });
      // eslint-disable-next-line no-await-in-loop
      const sent = await sendMessage(user.id, text);
      if (!sent) throw new Error('Telegram linked nahi hai — dashboard se Connect Telegram karo.');
      ok += 1;
      log.log(`[scheduler] 📲 morning schedule sent -> ${user.email} [${mode}]`);
    } catch (err) {
      log.error(`[scheduler] morning schedule FAILED for ${user.email}: ${err.message}`);
      if (err.name === 'SessionExpiredError' || err.name === 'NoSessionError') {
        // eslint-disable-next-line no-await-in-loop
        await maybeNotifySessionExpired(log, user.id);
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(500);
  }
  log.log(`[scheduler] 8:30 AM morning schedule done: ${ok}/${users.length} sent.`);
  return { sent: ok, total: users.length };
}

function startScheduler(log = console) {
  const summaryTask = cron.schedule(SUMMARY_CRON, () => runDailySummaryJob(log), { timezone: TIMEZONE });
  const morningTask = cron.schedule(MORNING_CRON, () => runMorningScheduleJob(log), { timezone: TIMEZONE });
  log.log(`[scheduler] armed — "${SUMMARY_CRON}" (9 PM summary) + "${MORNING_CRON}" (8:30 AM morning schedule), ${TIMEZONE}, saare users`);
  return [summaryTask, morningTask];
}

module.exports = {
  startScheduler,
  runDailySummaryJob,
  runMorningScheduleJob,
  getMorningScheduleText,
  SUMMARY_CRON,
  MORNING_CRON,
  TIMEZONE,
};

if (require.main === module) {
  const morning = process.argv.includes('--morning');
  if (process.argv.includes('--now')) {
    const job = morning ? runMorningScheduleJob : runDailySummaryJob;
    job().then((r) => process.exit(0));
  } else {
    startScheduler();
    console.log('[scheduler] running. Ctrl+C to stop.');
  }
}
