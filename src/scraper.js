/**
 * QUMS scraper — API-first approach (v2, reverse-engineered from the live
 * portal's own JavaScript).
 *
 * The dashboard's "Year/Sem Wise Attendance Summary" is a jqGrid populated by
 * an AJAX button-click, so DOM scraping is fragile. Instead we call the same
 * endpoints the portal itself calls, reusing session_state.json cookies:
 *
 *   GET  /Web_StudentAcademic/Cyborg_S_Dashboard   (page HTML -> RegID + YearSem)
 *   POST /Web_StudentAcademic/GetYearSemWiseAttendance  { RegID, YearSem }
 *        -> { data: "[{Subject, SubjectCode, Percentage, Toper,
 *                       TotalLecture, TotalPresent, TotalAbsent, TotalLeave}, ...]",
 *             state: "[{DateFrom, DateTo, TotalPercentage}]" }
 *
 * This returns EXACT attended/total counts — no estimation needed.
 *
 * NAVIGATION POLICY (no UI clicks): kabhi bhi Academic-tile/Time-Table-link
 * click-through mat karo — ye fragile hai. Sab kuch DIRECT URL/API calls hain:
 * saved session cookies (storageState) automatically access de dete hain.
 *   - Attendance: GET Cyborg_S_Dashboard -> POST GetYearSemWiseAttendance/GetTodayAttendance
 *   - Timetable:  POST FillStudentTimeTable (grid ka own AJAX), fallback page.goto(QUMS_TIMETABLE_URL)
 * Login pe redirect -> SessionExpiredError (looksLikeLoginHtml / throwIfLoginPage).
 *
 * Standalone:
 *   node src/scraper.js               -> prints attendance JSON
 *   node src/scraper.js --timetable   -> also prints parsed timetable JSON
 *   node src/scraper.js --today       -> today's attendance rows
 *   node src/scraper.js --month 9     -> Month Register (backdated) JSON
 * As a module:
 *   const { scrapeAttendance, scrapeTimetable, getTodaySubjects } = require('./scraper')
 *   const { scrapeMonthRegister, getMonthRegister, getTodaysTimetable,
 *           getTimetableForDate } = require('./scraper')
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { request: playwrightRequest, chromium } = require('playwright');

const SESSION_FILE = path.join(__dirname, '..', 'session_state.json');
const DASHBOARD_URL =
  process.env.QUMS_DASHBOARD_URL ||
  'https://qums.quantumuniversity.edu.in/Web_StudentAcademic/Cyborg_S_Dashboard';
const TIMETABLE_URL =
  process.env.QUMS_TIMETABLE_URL ||
  'https://qums.quantumuniversity.edu.in/Web_StudentAcademic/Cyborg_StudentTimeTable?id=Time%20Table';
const ATTENDANCE_API = '/Web_StudentAcademic/GetYearSemWiseAttendance';

class ScrapeError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'ScrapeError';
    this.hint = hint || null;
  }
}
class SessionExpiredError extends Error {
  constructor() {
    super('QUMS session expired — the portal returned the login page.');
    this.name = 'SessionExpiredError';
    this.hint = 'Dashboard → QUMS Setup → "Reconnect QUMS" — sirf captcha solve karna hai';
  }
}
class NoSessionError extends Error {
  constructor() {
    super('No saved QUMS session found (session_state.json missing).');
    this.name = 'NoSessionError';
    this.hint = 'Dashboard → QUMS Setup → pehli baar QID/password + captcha se setup karo';
  }
}

const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

function assertSessionFile(sessionPath = SESSION_FILE) {
  if (!fs.existsSync(sessionPath)) {
    const e = new NoSessionError();
    e.sessionPath = sessionPath;
    throw e;
  }
}

function looksLikeLoginHtml(html) {
  const lower = (html || '').toLowerCase();
  const hasLoginForm = /<input[^>]+type=["']password["']/.test(lower);
  const titleSaysLogin = /<title>[^<]*(login|sign in)/.test(lower);
  const noStudentData = !/var\s+RegID\s*=\s*'/i.test(lower);
  return (hasLoginForm && noStudentData) || titleSaysLogin;
}

/**
 * Browser page pe session-expired detection (no UI clicking — URL-only policy):
 * login pe redirect hua? -> clear SessionExpiredError throw karo.
 * 3 signals: (1) URL me 'login', (2) password input rendered hai,
 * (3) HTML shape login jaisi hai (looksLikeLoginHtml). QUMS login page root URL
 * (https://qums.quantumuniversity.edu.in/) pe serve hota hai — isliye sirf URL
 * check kaafi nahi, HTML check zaroori hai.
 */
async function throwIfLoginPage(page) {
  const lowerUrl = (page.url() || '').toLowerCase();
  if (lowerUrl.includes('login')) throw new SessionExpiredError();
  const passwordBoxes = await page.locator('input[type="password"]').count();
  if (passwordBoxes > 0) throw new SessionExpiredError();
  const html = await page.content().catch(() => '');
  if (looksLikeLoginHtml(html)) throw new SessionExpiredError();
}

/** Fetch the dashboard page and pull out the embedded RegID + selected Year/Sem. */
async function getStudentContext(apiContext) {
  const resp = await apiContext.get(DASHBOARD_URL, { timeout: 60000 });
  if (!resp.ok()) {
    throw new ScrapeError(`Dashboard load failed (HTTP ${resp.status()}).`, 'Portal down ho sakta hai — thodi der baad retry karo.');
  }
  const html = await resp.text();
  if (looksLikeLoginHtml(html)) throw new SessionExpiredError();

  const regIdMatch = html.match(/var\s+RegID\s*=\s*'(\d+)'/i);
  const regId = regIdMatch ? regIdMatch[1] : null;
  if (!regId) {
    throw new ScrapeError(
      'Dashboard HTML me RegID nahi mila.',
      'Session expire hoke login pe redirect hua ho sakta hai — Dashboard → QUMS Setup → "Reconnect QUMS" try karo, warna markup badla hai (node src/debug-dump.js chala kar debug-qums-dom.txt share karo).'
    );
  }

  // Year/Sem: prefer the <option selected> inside #ddlYearSemAttendance,
  // then the txtYearSem student-info cell, then QUMS_CURRENT_YEARSEM env
  // override. Koi static default NAHI (multi-user) — fail hone pe clear error.
  let yearSem = null;
  const ddlBlock = html.match(/id="ddlYearSemAttendance"[\s\S]{0,4000}?<\/select>/i);
  if (ddlBlock) {
    const selected = ddlBlock[0].match(/<option[^>]*selected[^>]*value="(\d+)"/i)
      || ddlBlock[0].match(/<option[^>]*value="(\d+)"[^>]*selected/i);
    if (selected) yearSem = selected[1];
  }
  if (!yearSem) {
    const txt = html.match(/id="txtYearSem"[^>]*>([^<]+)</i);
    if (txt && /^\d+$/.test(txt[1].trim())) yearSem = txt[1].trim();
  }
  if (!yearSem) {
    if (process.env.QUMS_CURRENT_YEARSEM) {
      yearSem = process.env.QUMS_CURRENT_YEARSEM;
    } else {
      // MULTI-USER: koi static semester default NAHI (pehle '5' hardcoded tha —
      // sirf ek user ke liye sahi tha). Galat semester = galat attendance data,
      // jo silent-wrong hai. Clear error + actionable hint better hai.
      throw new ScrapeError(
        'Year/Sem dashboard HTML se auto-detect nahi hua.',
        'Dashboard → QUMS Setup → "Reconnect QUMS" try karo (fresh session se detect ho jata hai), ya .env/Render env me QUMS_CURRENT_YEARSEM=<apna semester number> set karo.'
      );
    }
  }

  return { regId, yearSem };
}

/** Map one API row to the app's subject shape, with EXACT counts attached. */
function mapAttendanceRow(raw) {
  const num = (v) => {
    if (v === undefined || v === null || String(v).trim() === '') return null;
    const n = Number(String(v).trim());
    return Number.isFinite(n) ? n : null;
  };
  const row = {
    subject: norm(raw.Subject),
    subjectCode: norm(raw.SubjectCode),
    percentage: num(raw.Percentage),
    topAttendance: norm(raw.Toper) || undefined,
    totalClasses: num(raw.TotalLecture) ?? undefined,
    attended: num(raw.TotalPresent) ?? undefined,
    totalAbsent: num(raw.TotalAbsent) ?? undefined,
    totalLeave: num(raw.TotalLeave) ?? undefined,
    yearSem: norm(raw.YearSem) || undefined,
  };
  // Recompute percentage from exact counts when they exist and look sane.
  if (row.totalClasses > 0 && row.attended != null && row.attended >= 0) {
    row.percentageExact = Math.round((row.attended / row.totalClasses) * 1000) / 10;
  }
  return row;
}

/** Shared API context: session cookies + AJAX-ish headers, no browser needed. */
async function newApiContext(sessionPath = SESSION_FILE) {
  return playwrightRequest.newContext({
    storageState: sessionPath,
    baseURL: new URL(DASHBOARD_URL).origin,
    extraHTTPHeaders: { 'X-Requested-With': 'XMLHttpRequest', Referer: DASHBOARD_URL },
  });
}

/**
 * Main entry: scrape attendance for the current Year/Sem via the portal's
 * own API. opts: { sessionPath } (default = root session_state.json).
 * Returns an array of subject rows with EXACT counts:
 *   [{ subject, subjectCode, percentage, percentageExact, topAttendance,
 *      totalClasses, attended, totalAbsent, totalLeave, yearSem }]
 */
async function scrapeAttendance(opts = {}) {
  const sessionPath = opts.sessionPath || SESSION_FILE;
  assertSessionFile(sessionPath);
  const apiContext = await newApiContext(sessionPath);
  try {
    const { regId, yearSem } = await getStudentContext(apiContext);

    const resp = await apiContext.post(ATTENDANCE_API, {
      form: { RegID: regId, YearSem: yearSem },
      timeout: 60000,
    });
    if (!resp.ok()) {
      throw new ScrapeError(
        `Attendance API failed (HTTP ${resp.status()}).`,
        'Portal down ya session issue — thodi der baad retry, ya Dashboard → QUMS Setup → Reconnect QUMS.'
      );
    }
    let payload;
    try {
      payload = await resp.json();
    } catch {
      throw new SessionExpiredError(); // login pages respond with HTML here too
    }
    if (typeof payload.data !== 'string' || payload.data === '') {
      throw new ScrapeError(
        `Attendance API returned no data (YearSem=${yearSem}).`,
        `Semester galat lag sakta hai — .env me QUMS_CURRENT_YEARSEM set karke retry karo.`
      );
    }
    const rows = JSON.parse(payload.data).map(mapAttendanceRow).filter((r) => r.subject);
    if (!rows.length) {
      throw new ScrapeError(
        'Attendance API returned an empty subject list.',
        'Semester galat lag sakta hai — .env me QUMS_CURRENT_YEARSEM set karke retry karo.'
      );
    }

    // Overall summary (state JSON): { DateFrom, DateTo, TotalPercentage, ... }
    let summary = null;
    try {
      const st = JSON.parse(payload.state || '[]')[0];
      if (st) {
        summary = {
          dateFrom: norm(st.DateFrom),
          dateTo: norm(st.DateTo),
          overallPercentage: Number(st.TotalPercentage) || null,
        };
      }
    } catch {}

    return rows.map((r) => ({ ...r, periodSummary: summary }));
  } finally {
    await apiContext.dispose();
  }
}

// ---------------------------------------------------------------------------
// Today's Attendance (watcher ke liye) — the "Today's Attendance" jqGrid data.
// Portal contract (reverse-engineered from its own JS, FillAttendanceToday):
//   POST /Web_StudentAcademic/GetTodayAttendance  { RegID, date: 'DD/MM/YYYY' }
//   -> JSON body: "" (empty) | { state: "[{Period, Duration, subject,
//      SubjectCode, Employeename, Attend}, ...]" }
// `Attend` values: "N.M." = not marked; "P"/"A"/"PRESENT"/"ABSENT" etc. when marked.
// ---------------------------------------------------------------------------

const TODAY_ATTENDANCE_API = '/Web_StudentAcademic/GetTodayAttendance';
const MONTH_REGISTER_API = '/Web_StudentAcademic/GetMonthRegister';
const TIMETABLE_API = '/Web_StudentAcademic/FillStudentTimeTable';


/** Current date in IST as DD/MM/YYYY (the format QUMS APIs expect). */
function istDateString(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(d);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  return `${get('day')}/${get('month')}/${get('year')}`;
}

/** Normalize the portal's Attend value: 'unmarked' | 'present' | 'absent' | 'other'. */
function normalizeAttendanceValue(value) {
  const v = norm(value).toUpperCase().replace(/\./g, '');
  if (!v || v === 'NM' || v === 'NOT MARKED' || v === '-') return 'unmarked';
  if (v.includes('P')) return 'present'; // P / PRESENT (checked before A)
  if (v.includes('A')) return 'absent'; // A / ABSENT
  return 'other'; // e.g. L(EAVE) — notify with the raw value
}

/** Map one raw API row to the watcher's row shape (+ dedupe key). */
function mapTodayRow(raw) {
  const period = norm(raw.Period);
  const subjectCode = norm(raw.SubjectCode);
  return {
    period,
    duration: norm(raw.Duration),
    subject: norm(raw.subject),
    subjectCode,
    employee: norm(raw.Employeename),
    attendance: norm(raw.Attend),
    status: normalizeAttendanceValue(raw.Attend),
    key: `${period}-${subjectCode}`,
  };
}

/**
 * Scrape "Today's Attendance" rows. opts: { sessionPath, date }.
 * Rows: [{ period, duration, subject, subjectCode, employee, attendance, status, key }]
 * Empty portal response ("") -> [].
 */
async function scrapeTodaysAttendance(opts = {}) {
  const dateStr = typeof opts === 'string' ? opts : opts.date; // legacy: string date
  const sessionPath = (typeof opts === 'object' && opts.sessionPath) || SESSION_FILE;
  assertSessionFile(sessionPath);
  const apiContext = await newApiContext(sessionPath);
  try {
    const { regId } = await getStudentContext(apiContext);
    const date = dateStr || istDateString();

    const resp = await apiContext.post(TODAY_ATTENDANCE_API, {
      form: { RegID: regId, date },
      timeout: 60000,
    });
    if (!resp.ok()) {
      throw new ScrapeError(
        `Today's-attendance API failed (HTTP ${resp.status()}).`,
        'Portal down ya session issue — thodi der baad retry, ya Dashboard → QUMS Setup → Reconnect QUMS.'
      );
    }
    const body = await resp.text();
    if (body.trim().startsWith('<')) throw new SessionExpiredError(); // HTML = login page

    let rawRows = [];
    try {
      const parsed = JSON.parse(body);
      if (Array.isArray(parsed)) rawRows = parsed;
      else if (parsed && typeof parsed.state === 'string' && parsed.state.trim()) {
        rawRows = JSON.parse(parsed.state);
      }
    } catch {
      rawRows = []; // unparseable = treat as "nothing yet"
    }
    return rawRows.map(mapTodayRow).filter((r) => r.period || r.subject);
  } finally {
    await apiContext.dispose();
  }
}

/**
 * Bonus: parse the timetable grid (Days x Periods) — DOM-based (no simple JSON
 * endpoint). Handles BOTH layouts seen in the wild:
 *   1. plain table: header row ["Day","P1",...], day name in the FIRST cell
 *   2. live QUMS jqGrid: period headers live in a sibling table
 *      (table.ui-jqgrid-htable: ["", "Days/Period", "(P1)09:00 - 09:55", ...]),
 *      and data rows look like ["1", "Monday", "Subject(CODE) (Room),Teacher", ...]
 *      — row-number col first, day name in the SECOND cell.
 * Day column is auto-detected by matching a weekday name in each row, so both
 * layouts (and header rows with empty cells) work.
 */
function parseTimetableInPage() {
  const normLocal = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const DAY_RE = /^(monday|tuesday|wednesday|thursday|thrusday|friday|saturday|sunday|mon|tues|wed|thurs|thrus|fri|sat|sun)\b/i;
  let best = null;
  for (const table of document.querySelectorAll('table')) {
    const trs = Array.from(table.querySelectorAll('tr'));
    if (!trs.length) continue;

    // Header: <thead> ka last row, warna pehli row; empty ho to jqGrid ke
    // sibling header-table (ui-jqgrid-htable) se.
    let headerCells = null;
    if (table.tHead && table.tHead.rows.length) {
      headerCells = Array.from(table.tHead.rows[table.tHead.rows.length - 1].cells).map((c) => normLocal(c.textContent));
    }
    if (!headerCells || headerCells.filter(Boolean).length < 2) {
      headerCells = Array.from(trs[0].querySelectorAll('th,td')).map((c) => normLocal(c.textContent));
    }
    if (!headerCells || headerCells.filter(Boolean).length < 2) {
      const ht = document.querySelector('table.ui-jqgrid-htable');
      if (ht) {
        for (let r = ht.rows.length - 1; r >= 0; r--) {
          const cs = Array.from(ht.rows[r].cells).map((c) => normLocal(c.textContent));
          if (cs.filter(Boolean).length >= 2) {
            headerCells = cs;
            break;
          }
        }
      }
    }

    const days = [];
    for (const tr of trs) {
      const cells = Array.from(tr.querySelectorAll('th,td')).map((c) => normLocal(c.textContent));
      const dayIdx = cells.findIndex((c) => DAY_RE.test(c));
      if (dayIdx === -1) continue; // header / empty jqGrid row
      const periods = cells.slice(dayIdx + 1).map((text, i) => ({
        period: (headerCells && headerCells[dayIdx + 1 + i]) || `P${i + 1}`,
        text,
      }));
      days.push({ day: cells[dayIdx], periods });
    }
    if (days.length >= 2 && (!best || days.length > best.days.length)) {
      best = { periods: (headerCells || []).slice(2), days };
    }
  }
  return best;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Subject code pattern: QUMS codes like CS35303, AE35362, SI35375 (2-6 digits bhi chalega). */
const CODE_RE = /([A-Za-z]{2,4}\d{2,6})/;

/** 'CS35303 (Design and Analysis of Algorithm (S))' -> { subjectCode, subject }. */
function parseSubjectLabel(label) {
  const text = norm(label);
  const m = text.match(/^([A-Za-z]{2,4}\d{2,6})\s*\((.*)\)$/);
  if (m) {
    // trailing "(S)"/"(L)"/"(T)" section-tag hata do (display ke liye)
    const subject = norm(m[2]).replace(/\s*\(([SLT])\)$/i, '');
    return { subjectCode: m[1].toUpperCase(), subject };
  }
  const c = text.match(CODE_RE);
  return { subjectCode: c ? c[1].toUpperCase() : '', subject: text };
}

/**
 * Timetable period cell — step-by-step parsing (single-regex nahi, kyunki
 * cell format hamesha same nahi hota: room kabhi 1 paren group, kabhi 2 —
 * labs me section suffix ke saath).
 *
 * Live examples:
 *   "Design and Analysis of Algorithm (CS35303) (A-004),RAJ KUMAR"
 *       -> { subject: 'Design and Analysis of Algorithm', subjectCode: 'CS35303', room: 'A-004', teacher: 'RAJ KUMAR' }
 *   "Design and Analysis of Algorithm Lab(CS35363) (E-202)(B),RAJ KUMAR"
 *       -> { ..., room: 'E-202B', ... }   (E-202 + B join)
 *   "R Programming(CS3026/CS30364) (A-102),TEACHER NAME"
 *       -> { subjectCode: 'CS3026/CS30364', room: 'A-102', ... }
 *
 * 1) Teacher hamesha LAST comma ke baad (subject names me comma ho sakte hain).
 * 2) Saare (...) groups: pehla = subject code, baaki join = room.
 * 3) Subject = parens hata ke jo bacha.
 */
function splitTimetableEntries(text) {
  const entries = [];
  let cur = '';
  let phase = 'subject'; // subject -> paren -> post-paren -> teacher (comma ke baad)
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') {
      const close = text.indexOf(')', i);
      const end = close === -1 ? text.length : close + 1;
      cur += text.slice(i, end);
      i = end - 1;
      phase = 'post-paren';
      continue;
    }
    if (ch === ',' && phase === 'post-paren') {
      phase = 'teacher';
      cur += ch;
      continue;
    }
    if (ch === '-' && phase === 'teacher') {
      // boundary: agle '(' tak koi ',' ya '(' nahi — teacher khatam, naya subject
      const nextParen = text.indexOf('(', i);
      const nextComma = text.indexOf(',', i);
      if (nextParen !== -1 && (nextComma === -1 || nextParen < nextComma)) {
        entries.push(cur);
        cur = '';
        phase = 'subject';
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim()) entries.push(cur);
  return entries;
}

/** Cell ke saare subject entries (multi-subject cells supported). */
function parseTimetableCellEntries(rawText) {
  const text = norm(rawText);
  if (!text) return [];
  return splitTimetableEntries(text).map((entry) => {
    const lastComma = entry.lastIndexOf(',');
    const teacher = lastComma !== -1 ? norm(entry.slice(lastComma + 1)) : '';
    const beforeTeacher = lastComma !== -1 ? entry.slice(0, lastComma) : entry;
    const groups = [];
    const parenRe = /\(([^()]*)\)/g;
    let m;
    while ((m = parenRe.exec(beforeTeacher)) !== null) groups.push(m[1].trim());
    const subjectCode = groups[0] || '';
    const room = groups.slice(1).join('');
    const subject = norm(beforeTeacher.replace(/\([^)]*\)/g, ''));
    return { subject, subjectCode, room, teacher };
  });
}

/** First-entry compat wrapper (purana naam — single-subject cells ke liye same). */
function parseTimetableCell(rawText) {
  const entries = parseTimetableCellEntries(rawText);
  return entries[0] || { subject: '', subjectCode: '', room: '', teacher: '' };
}

/** FillStudentTimeTable ka `state` rows -> timetable { periods, days }. */
function parseTimetableApiState(rows) {
  const periodKeys = [];
  for (const row of rows || []) {
    for (const k of Object.keys(row || {})) {
      if (k !== 'Days/Period' && !periodKeys.includes(k)) periodKeys.push(k);
    }
  }
  const days = (rows || [])
    .map((row) => ({
      day: norm(row['Days/Period']),
      periods: periodKeys.map((pk) => ({ period: pk, text: norm(row[pk] || '') })),
    }))
    .filter((d) => d.day);
  return { periods: periodKeys, days };
}

/** Alias — purana naam, same logic. */
const parsePeriodCell = parseTimetableCell;


/** 'YYYY-MM-DD' | 'DD/MM/YYYY' -> Date (civil/local, weekday TZ-safe). */
function dateFromAny(dateLike) {
  if (dateLike instanceof Date) return dateLike;
  const s = String(dateLike || '');
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/**
 * Day-name matching portal ke typos ko bhi handle kare — especially
 * "Thrusday" (T-h-r-u!) jo startsWith('thu') se KABHI match nahi hota.
 * Canonical: pehle 3 letters -> alias table (thr/thu => thursday, tues => tuesday).
 */
const DAY_ALIASES = { thu: 'thursday', thr: 'thursday', tues: 'tuesday', wen: 'wednesday', mon: 'monday', tue: 'tuesday', wed: 'wednesday', fri: 'friday', sat: 'saturday', sun: 'sunday' };

function canonicalDayKey(name) {
  const k = String(name || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 3);
  return DAY_ALIASES[k] || k;
}

/**
 * getTodaySubjects ka generalized version: kisi bhi date ka weekday nikaal ke
 * timetable grid ki us row ko parse karta hai — teacher + room ke saath.
 */
function getTimetableForDate(timetable, date = new Date()) {
  if (!timetable || !Array.isArray(timetable.days)) return [];
  const wd = dateFromAny(date).getDay();
  const want = canonicalDayKey(DAY_NAMES[wd]);
  const row = timetable.days.find(
    (d) => canonicalDayKey(d.day) === want
  );
  if (!row) return [];
  return row.periods
    .filter((p) => p.text && p.text.length > 2 && !/break|lunch|^free/i.test(p.text))
    .flatMap((p) => {
      // multi-subject cell (Friday jaisa) -> har subject apni entry (own room/teacher)
      const dur = (p.period || '').match(/\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}/);
      const duration = dur ? norm(dur[0]) : '';
      return parseTimetableCellEntries(p.text).map((cell) => ({
        period: p.period,
        duration,
        subject: cell.subject || '',
        subjectCode: cell.subjectCode || '',
        room: cell.room || '',
        teacher: cell.teacher || '',
        raw: p.text,
      }));
    });
}

/**
 * Map a weekday onto the parsed timetable and extract subject names/codes
 * from cells like "Subject Name(CODE) (Room), Teacher Name".
 */
function getTodaySubjects(timetable, now = new Date()) {
  return getTimetableForDate(timetable, now);
}


async function createSessionContext(sessionPath = SESSION_FILE) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: sessionPath,
    viewport: { width: 1366, height: 900 },
  });
  return { browser, context };
}

/** FillStudentTimeTable API se timetable (bina browser) — VPS-friendly. */
async function fetchTimetableViaApi(apiContext, regId) {
  const resp = await apiContext.post(TIMETABLE_API, { form: { RegID: regId }, timeout: 60000 });
  if (!resp.ok()) {
    throw new ScrapeError(
      `TimeTable API failed (HTTP ${resp.status()}).`,
      'Portal down ho sakta hai — thodi der baad retry.'
    );
  }
  const body = await resp.text();
  if (body.trim().startsWith('<')) throw new SessionExpiredError(); // login/403 page
  let rows = [];
  try {
    const payload = JSON.parse(body);
    rows = JSON.parse(payload.state || '[]');
  } catch {
    rows = [];
  }
  if (!Array.isArray(rows) || !rows.length) {
    throw new ScrapeError('TimeTable API ne khali data diya.', 'Portal change ho sakta hai — debug-timetable-net.js chalao.');
  }
  return parseTimetableApiState(rows);
}

async function scrapeTimetable(opts = {}) {
  const sessionPath = opts.sessionPath || SESSION_FILE;
  assertSessionFile(sessionPath);

  // 1) API-first: FillStudentTimeTable — browser-free (fast + VPS-safe).
  //    Rooms/teachers wahi text format me aate hain jo parser expect karta hai.
  const apiContext = await newApiContext(sessionPath);
  try {
    const { regId } = await getStudentContext(apiContext);
    const viaApi = await fetchTimetableViaApi(apiContext, regId);
    if (viaApi.days && viaApi.days.length) {
      viaApi.source = 'api';
      return viaApi;
    }
  } catch (err) {
    if (err.name === 'SessionExpiredError') throw err; // session dead — browser se bhi nahi hoga
    // API fail (shape change etc.) — niche browser fallback try hota hai
  } finally {
    await apiContext.dispose();
  }

  // 2) Fallback: headless browser parse (jqGrid DOM) — retry ke saath
  const { browser, context } = await createSessionContext(sessionPath);
  try {
    let timetable = null;
    // Portal WAF kabhi-kabhi lagataar requests pe grid ka AJAX rok deta hai —
    // ek retry (fresh navigation) rakha hai.
    for (let attempt = 1; attempt <= 2 && !timetable; attempt++) {
      if (attempt > 1) await new Promise((r) => setTimeout(r, 4000));
      const page = await context.newPage();
      try {
        await page.goto(TIMETABLE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        try {
          await page.waitForLoadState('networkidle', { timeout: 15000 });
        } catch {}
        // Direct-URL navigation: page.goto se session cookies kaam karte hain,
        // koi Academic-tile/Time-Table-link click nahi. Login pe redirect ->
        // throwIfLoginPage clear SessionExpiredError deta hai (3 signals).
        await throwIfLoginPage(page);
        // Grid AJAX ke baad render hota hai — kisi cell me weekday name aa jaane
        // tak wait karo (race-safe; timeout pe jo hai wahi parse hoga).
        await page
          .waitForFunction(
            () => /monday|tuesday|wednesday|thursday|thrusday|friday|saturday|sunday/i.test(document.body ? document.body.innerText : ''),
            { timeout: 20000 }
          )
          .catch(() => {});
        await page.waitForTimeout(2000);
        timetable = await page.evaluate(parseTimetableInPage);
      } finally {
        await page.close().catch(() => {});
      }
    }
    if (!timetable) {
      throw new ScrapeError(
        'Timetable grid parsed to nothing — markup differs from expectations.',
        'Inspect the timetable page in DevTools and update parseTimetableInPage in src/scraper.js'
      );
    }
    return timetable;
  } finally {
    await browser.close();
  }
}


// ---------------------------------------------------------------------------
// Month Register (backdated attendance) — API-first, live-UI se reverse-
// engineered (debug-inspect-month-register.js + debug-month-api-probe.js):
//
//   POST /Web_StudentAcademic/GetMonthRegister  { RegID, Month: 1..12 }
//     -> { state: "[{\"Subject\":\"CS35303 (Design and ... (S))\",
//                    \"1\":\"P\",\"2\":\"P\",\"3\":\"N\", ..., \"30\":\"N\"}, ...]",
//          data: "[{\"Total\":\"0\",\"Present\":\"0\",\"Absent\":\"0\",\"Percet\":\"0.00 %\"}]" }
//
//   Cell values: "P" present | "A" absent | "N" not marked | "P,P" = same day
//   me 2 lectures. Month Register me TEACHER ka column NAHI hota — teacher
//   timetable (getTimetableForDate) se cross-match hota hai.
//   Dashboard ke Present/Absent/Diff Lecture buttons sirf LEGEND hain
//   (readonly inputs, no onclick) — koi filter toggle nahi.
// ---------------------------------------------------------------------------

/** 'September' | 'Sep' | 9 | '9' -> 9 (1..12); invalid -> null. */
function monthFromName(monthName) {
  if (monthName == null || monthName === '') return null;
  const n = Number(monthName);
  if (Number.isInteger(n) && n >= 1 && n <= 12) return n;
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const s = String(monthName).trim().toLowerCase();
  const exact = MONTHS.findIndex((m) => m === s);
  if (exact !== -1) return exact + 1;
  const partial = MONTHS.findIndex((m) => m.startsWith(s) && s.length >= 3);
  if (partial !== -1) return partial + 1;
  return null;
}

/** Raw GetMonthRegister rows -> flat records (N skip; "P,P" = 2 lectures breakdown; EK alert per subject/day). */
function expandMonthRegisterRows(rawRows, { year, month } = {}) {
  const out = [];
  const ym = `${year}-${String(month).padStart(2, '0')}`;
  for (const row of rawRows || []) {
    if (!row || !row.Subject) continue;
    const { subjectCode, subject } = parseSubjectLabel(row.Subject);
    for (const [key, val] of Object.entries(row)) {
      if (key === 'Subject') continue;
      const day = Number(key);
      if (!Number.isInteger(day) || day < 1 || day > 31) continue;
      const v = norm(val).toUpperCase();
      if (!v || v === 'N') continue; // N = not marked
      // "P,P" = us din 2 lectures — EK record (ek hi alert), lectures breakdown ke saath
      const lectures = v.split(',').map((s) => s.trim()).filter(Boolean)
        .map((l) => ({ statusRaw: l, status: normalizeAttendanceValue(l) }));
      const ymd = `${ym}-${String(day).padStart(2, '0')}`;
      out.push({
        date: ymd,
        day,
        subjectCode,
        subject,
        statusRaw: lectures.map((l) => l.statusRaw).join(','),
        status: lectures[0].status, // primary = pehla lecture
        lectures,
        lecturesThatDay: lectures.length,
        key: `${ymd}-${subjectCode}`, // group key: ek hi alert per subject/day
      });
    }
  }
  return out;
}

/**
 * Month Register scrape — koi UI click nahi, seedha portal ka AJAX endpoint.
 * opts: { sessionPath, month (1..12, default current IST month), year? }
 * Returns { year, month, records, summary } — records me backdated + aaj ke
 * marked periods sab hote hain.
 */
async function scrapeMonthRegister(opts = {}) {
  const sessionPath = opts.sessionPath || SESSION_FILE;
  assertSessionFile(sessionPath);
  const [, curMonth, curYear] = istDateString().split('/').map(Number);
  const month = Number(opts.month) || curMonth;
  // Year guess: future month poocha to pichhle saal ka (Jan'27 me "December" => Dec 2026).
  const year = Number(opts.year) || (month > curMonth ? curYear - 1 : curYear);
  const apiContext = await newApiContext(sessionPath);
  try {
    const { regId } = await getStudentContext(apiContext);
    const resp = await apiContext.post(MONTH_REGISTER_API, {
      form: { RegID: regId, Month: month },
      timeout: 60000,
    });
    if (!resp.ok()) {
      throw new ScrapeError(
        `Month Register API failed (HTTP ${resp.status()}).`,
        'Portal down ya session issue — thodi der baad retry, ya Dashboard → QUMS Setup → Reconnect QUMS.'
      );
    }
    const body = await resp.text();
    if (body.trim().startsWith('<')) throw new SessionExpiredError(); // HTML = login/403 page
    let payload = {};
    try {
      payload = JSON.parse(body);
    } catch {
      payload = {};
    }
    let rawRows = [];
    try {
      rawRows = JSON.parse(payload.state || '[]');
    } catch {
      rawRows = [];
    }
    let summary = null;
    try {
      const s = JSON.parse(payload.data || '[]')[0];
      if (s) {
        summary = {
          total: Number(s.Total) || 0,
          present: Number(s.Present) || 0,
          absent: Number(s.Absent) || 0,
          percentage: String(s.Percet || '').trim() || null,
        };
      }
    } catch {}
    const records = expandMonthRegisterRows(rawRows, { year, month });
    return { year, month, records, summary };
  } finally {
    await apiContext.dispose();
  }
}

/** Ek month-register record ke liye timetable se teacher cross-match karo. */
function teacherForRecord(timetable, rec) {
  if (!timetable || !rec || !rec.date) return '';
  const periods = getTimetableForDate(timetable, rec.date);
  const hit = periods.find((p) => p.subjectCode && p.subjectCode === rec.subjectCode);
  return (hit && hit.teacher) || '';
}

/** Ek month-register record ke liye timetable se ROOM cross-match karo. */
function roomForRecord(timetable, rec) {
  if (!timetable || !rec || !rec.date) return '';
  const hit = getTimetableForDate(timetable, rec.date).find((p) => p.subjectCode && p.subjectCode === rec.subjectCode);
  return (hit && hit.room) || '';
}

/**
 * Spec API: getTodaysTimetable(userId) — aaj ki periods (teacher + room ke saath).
 * Direct-URL navigation (no UI clicks): primary path FillStudentTimeTable API
 * (wahi endpoint jo Cyborg_StudentTimeTable grid khud call karta hai —
 * debug-timetable-net.txt me captured), fallback seedha
 * page.goto(QUMS_TIMETABLE_URL) — Academic tile / Time Table link click nahi.
 * Room number innerText se aata hai — "(CODE) (ROOM)" paren groups
 * (title attribute portal me hota hi nahi, debug-cells-dump.txt me confirm).
 * Session expired -> SessionExpiredError (dono paths pe).
 */
async function getTodaysTimetable(userId) {
  const timetable = await scrapeTimetable({ sessionPath: db.sessionPathFor(userId) });
  return getTimetableForDate(timetable, new Date());
}

/**
 * PURE merge (Task 1 spec): subject + teacher "Today's Attendance" se (clean/
 * reliable — QUMS isi se marking karta hai), room SIRF Timetable se.
 * Match: pehle subjectCode, na mile to period. Na mile to room = null
 * (frontend/message "N/A" dikha sakta hai).
 */
function mergeScheduleWithRoom(todaysRows, timetablePeriods) {
  const tt = timetablePeriods || [];
  return (todaysRows || []).map((row) => {
    const match =
      tt.find((t) => t.subjectCode && row.subjectCode && t.subjectCode === row.subjectCode) ||
      tt.find((t) => t.period && row.period && t.period === row.period) ||
      null;
    return {
      period: row.period,
      duration: row.duration,
      subject: row.subject,
      subjectCode: row.subjectCode,
      teacher: row.employee || '', // teacherName — Today's Attendance se
      attendance: row.attendance,
      status: row.status,
      key: row.key,
      room: match ? match.room || null : null,
    };
  });
}

/**
 * Spec API: getTodaysAttendance(userId) — aaj ke periods (attendance status ke saath).
 * Direct-URL navigation (no UI clicks): session file (storageState) se cookies
 * utha kar seedha Cyborg_S_Dashboard GET + GetTodayAttendance POST — Academic
 * tile click-through ki zaroorat nahi. Session file project convention:
 * db.sessionPathFor(userId) = data/qums-sessions/<userId>.json (wahi path
 * jahan qums-login-web.js sessions save karta hai).
 * Session expired (login redirect/HTML response) -> SessionExpiredError.
 */
async function getTodaysAttendance(userId) {
  return scrapeTodaysAttendance({ sessionPath: db.sessionPathFor(userId) });
}

/**
 * Spec API: getTodaysScheduleWithRoom(userId) — MERGED schedule:
 *   [{ period, duration, subject, subjectCode, teacher, room, attendance, status }]
 * Side-effect: result ka (period, subject, subjectCode, teacher, room) aaj ke
 * dayOfWeek pe weekly_schedule_cache me UPSERT ho jata hai (Task 2).
 */
async function getTodaysScheduleWithRoom(userId) {
  const todaysRows = await scrapeTodaysAttendance({ sessionPath: db.sessionPathFor(userId) });
  let timetablePeriods = [];
  try {
    const timetable = await scrapeTimetable({ sessionPath: db.sessionPathFor(userId) });
    timetablePeriods = getTimetableForDate(timetable, new Date());
  } catch {
    timetablePeriods = []; // timetable na mile to room null rahega (live rows theek hain)
  }
  const merged = mergeScheduleWithRoom(todaysRows, timetablePeriods);
  const dow = new Date().getDay();
  db.upsertWeeklySchedule(
    userId,
    dow,
    merged.map((r) => ({
      period: r.period,
      subject: r.subject,
      subjectCode: r.subjectCode,
      teacher: r.teacher,
      room: r.room,
    }))
  );
  return merged;
}

/**
 * Spec API: getMonthRegister(userId, monthName) — flat records with teacher
 * (timetable cross-match se; timetable na mile to teacher '' rehta hai).
 */
async function getMonthRegister(userId, monthName) {
  const sessionPath = db.sessionPathFor(userId);
  const month = monthFromName(monthName);
  const reg = await scrapeMonthRegister({ sessionPath, month });
  let timetable = null;
  try {
    timetable = await scrapeTimetable({ sessionPath });
  } catch {
    timetable = null; // teacher optional rahega
  }
  return reg.records.map((rec) => ({ ...rec, teacher: teacherForRecord(timetable, rec) }));
}

module.exports = {

  scrapeAttendance,
  scrapeTodaysAttendance,
  scrapeMonthRegister,
  scrapeTimetable,
  getTodaySubjects,
  getTimetableForDate,
  getTodaysTimetable,
  getTodaysAttendance,
  getTodaysScheduleWithRoom,
  mergeScheduleWithRoom,
  getMonthRegister,
  monthFromName,
  expandMonthRegisterRows,
  parseSubjectLabel,
  parsePeriodCell,
  parseTimetableCell,
  parseTimetableCellEntries,
  parseTimetableApiState,
  fetchTimetableViaApi,
  teacherForRecord,
  roomForRecord,
  dateFromAny,
  mapAttendanceRow,
  mapTodayRow,
  normalizeAttendanceValue,
  istDateString,
  getStudentContext,
  looksLikeLoginHtml,
  ScrapeError,
  SessionExpiredError,
  NoSessionError,
};

if (require.main === module) {
  const wantTimetable = process.argv.includes('--timetable');
  const wantToday = process.argv.includes('--today');
  const monthIdx = process.argv.indexOf('--month');
  const wantMonth = monthIdx !== -1 ? Number(process.argv[monthIdx + 1]) || null : null;
  (async () => {
    try {
      const result = {};
      if (wantToday) {
        result.todayAttendance = await scrapeTodaysAttendance();
      }
      if (wantMonth) {
        result.monthRegister = await scrapeMonthRegister({ month: wantMonth });
      }
      if (!wantToday && !wantMonth) {
        result.attendance = await scrapeAttendance();
      }
      if (wantTimetable) {
        try {
          const timetable = await scrapeTimetable();
          result.timetable = timetable;
          result.todaySubjects = getTodaySubjects(timetable);
        } catch (err) {
          result.timetableError = err.message;
        }
      }
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(`[x] ${err.name || 'Error'}: ${err.message}`);
      if (err.hint) console.error(`    hint: ${err.hint}`);
      process.exit(1);
    }
  })();
}
