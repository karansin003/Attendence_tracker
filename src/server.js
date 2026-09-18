/**
 * Express server — MULTI-USER QUMS Attendance Bot (Phase 2).
 *
 * Public pages:     /login  /register  /forgot  /reset
 * Protected pages:  /dashboard  /qums-setup
 * Public APIs:      /health  /api/register  /api/login  /api/forgot  /api/reset
 * Protected APIs:   /api/me  /api/attendance  /api/today  /api/trigger-telegram
 *                   /api/telegram/status  /api/telegram/unlink
 *                   /api/qums-login/start  /api/qums-login/submit-captcha  /api/logout
 *
 * Auth: express-session (90-din cookie, file store — restart pe bhi persist),
 * bcrypt password hashes, QUMS password AES-256-GCM encrypted at rest.
 * Root route: no users -> /register; else no session -> /login; else /dashboard.
 *
 * Background: scheduler (8:30 AM schedule + 9 PM summary) + per-class watcher.
 * Telegram: ONE bot (@qums_attendance_bot, polling mode) — har user apne
 * dashboard se deep-link connect karta hai; sends uske apne chat pe jaate hain.
 *
 * Run: npm start
 */
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');

const db = require('./db');
const { encryptSecret } = require('./crypto');
const { resolveUserRuntime } = require('./credentials');
const { scrapeAttendance, scrapeTodaysAttendance } = require('./scraper');
const { analyzeAttendance } = require('./calculator');
const telegram = require('./telegram');
const { sendMessage } = require('./telegram');
const { startScheduler, runDailySummaryJob, runMorningScheduleJob, getMorningScheduleText } = require('./scheduler');
const { startWatcher, runBaselineForUser } = require('./watcher');
const qumsLogin = require('./qums-login-web');
const { formatMorningSchedule, formatAttendanceMessage } = require('./messages');

const app = express();
const PORT = Number(process.env.PORT) || 10000; // Render PORT deta hai; local fallback 10000
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SESSION_DIR = path.join(__dirname, '..', 'data', 'app-sessions');
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me';
// Render automatically RENDER=true set karta hai — NODE_ENV bhool jao to bhi
// secure-cookie/prod behavior theek rahega.
const IS_PROD = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER);

if (IS_PROD && !process.env.SESSION_SECRET) {
  console.error('[server] ⚠️ SESSION_SECRET missing in production — insecure dev fallback in use!');
  console.error('[server] ⚠️ Render Dashboard → Environment → SESSION_SECRET set karo (phir restart).');
}

/**
 * Public base URL — deployment-safe resolution order:
 *   1. APP_BASE_URL               (explicit; Render Dashboard → Environment me set)
 *   2. RENDER_EXTERNAL_URL        (Render khud inject karta hai — APP_BASE_URL
 *                                  set karna bhool jao to bhi reset link sahi banega)
 *   3. http://localhost:<PORT>    (LOCAL DEV ONLY — production me pehle dono
 *                                  available hote hain, isliye localhost kabhi
 *                                  production reset links me nahi jaayega)
 * Trailing "/" normalize hota hai -> `https://host//reset` jaisa bug kabhi nahi.
 */
function normalizeBaseUrl(u) {
  return String(u || '').trim().replace(/\/+$/, '');
}
const BASE_URL =
  normalizeBaseUrl(process.env.APP_BASE_URL) ||
  normalizeBaseUrl(process.env.RENDER_EXTERNAL_URL) ||
  `http://localhost:${PORT}`;

fs.mkdirSync(SESSION_DIR, { recursive: true }); // Render/first-run pe dir missing na ho

app.disable('x-powered-by');
app.set('trust proxy', 1); // Render ke reverse proxy ke peeche req.protocol/secure sahi rahe
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(
  session({
    store: new FileStore({
      path: SESSION_DIR,
      ttl: 90 * 24 * 60 * 60, // seconds — 90 din
      logFn: () => {}, // silence file-store noise
    }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 90 * 24 * 60 * 60 * 1000, // 90 din
      httpOnly: true, // JS se cookie accessible nahi (XSS safe-ish)
      sameSite: 'lax', // basic CSRF protection
      secure: IS_PROD, // production me HTTPS-only
    },
  })
);

// ---- helpers ----
function currentUser(req) {
  if (!req.session || !req.session.userId) return null;
  return db.getUserById(req.session.userId);
}

/** Pages -> redirect /login; APIs -> 401 JSON. /api/auth/* aur /health public rehte hain. */
function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (user) {
    req.appUser = user;
    return next();
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Login required', code: 'AUTH_REQUIRED' });
  }
  return res.redirect('/login');
}

function httpStatusFor(err) {
  if (err.name === 'QumsSetupRequired') return 403;
  if (err.name === 'SessionExpiredError' || err.name === 'NoSessionError') return 409;
  if (err.name === 'NoPendingLogin' || err.name === 'TelegramNotLinked') return 409;
  if (err.name === 'QumsCredsMissing') return 400;
  if (err.name === 'ScrapeError') return 502;
  return 500;
}

function validEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ''));
}

// ---- minimal in-memory rate limiter (auth endpoints — brute-force/email-spam guard) ----
const RATE_WINDOW_MS = 15 * 60 * 1000; // 15 min window
const RATE_LIMITS = { '/api/login': 20, '/api/register': 10, '/api/forgot': 5, '/api/reset': 10 };
const rateHits = new Map(); // `${ip}:${route}` -> [hit timestamps]

function rateLimit(route) {
  const max = RATE_LIMITS[route];
  return (req, res, next) => {
    const key = `${req.ip || 'unknown'}:${route}`;
    const now = Date.now();
    const hits = (rateHits.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
    if (hits.length >= max) {
      return res.status(429).json({ error: 'Bahut zyada requests — thodi der baad try karo.' });
    }
    hits.push(now);
    rateHits.set(key, hits);
    if (rateHits.size > 5000) {
      // memory growth guard: purani entries delete
      for (const [k, v] of rateHits) {
        if (!v.some((t) => now - t < RATE_WINDOW_MS)) rateHits.delete(k);
      }
    }
    return next();
  };
}

/** 500s: prod me generic message (internals leak na ho), dev me detail. */
function safeServerError(res, err) {
  console.error('[server] route error:', err.name || 'Error', '-', err.message);
  const msg = IS_PROD ? 'Server error. Thodi der baad try karo.' : `${err.name || 'Error'}: ${err.message}`;
  res.status(500).json({ error: msg });
}

// ---- page routes ----
app.get('/', (req, res) => {
  if (!db.hasUsers()) return res.redirect('/register');
  if (!currentUser(req)) return res.redirect('/login');
  return res.redirect('/dashboard');
});

const sendPage = (name) => (req, res) => res.sendFile(path.join(PUBLIC_DIR, name));
app.get('/register', sendPage('register.html'));
app.get('/login', sendPage('login.html'));
app.get('/forgot', sendPage('forgot.html'));
app.get('/reset', sendPage('reset.html'));

app.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});
app.get('/qums-setup', requireAuth, sendPage('qums-setup.html'));

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---- auth APIs (public; rate-limited) ----
app.post('/api/register', rateLimit('/api/register'), async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!validEmail(email)) return res.status(400).json({ error: 'Valid email daalo.' });
    if (!password || String(password).length < 6) {
      return res.status(400).json({ error: 'Password kam se kam 6 characters ka hona chahiye.' });
    }
    if (db.getUserByEmail(email)) {
      return res.status(409).json({ error: 'Ye email already registered hai — Login karo.' });
    }
    const passwordHash = await bcrypt.hash(String(password), 10);
    const user = db.createUser({ email, passwordHash });
    req.session.userId = user.id; // auto-login after register
    res.json({ ok: true, redirect: '/qums-setup' });
  } catch (err) {
    safeServerError(res, err);
  }
});

app.post('/api/login', rateLimit('/api/login'), async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const user = db.getUserByEmail(email);
    if (!user || !(await bcrypt.compare(String(password || ''), user.passwordHash))) {
      return res.status(401).json({ error: 'Email ya password galat hai.' });
    }
    req.session.userId = user.id;
    res.json({ ok: true, redirect: user.qumsSessionPath ? '/dashboard' : '/qums-setup' });
  } catch (err) {
    safeServerError(res, err);
  }
});

/** Always-ok response (user enumeration se bachne ke liye). SMTP optional. */
app.post('/api/forgot', rateLimit('/api/forgot'), async (req, res) => {
  try {
    const { email } = req.body || {};
    const user = db.getUserByEmail(email);
    if (user) {
      const token = require('crypto').randomBytes(24).toString('hex');
      db.storeResetToken(user.email, token);
      // BASE_URL: APP_BASE_URL || RENDER_EXTERNAL_URL || localhost (normalized) —
      // production me localhost KABHI nahi (Render pe upar wale dono set hote hain).
      const link = `${BASE_URL}/reset?token=${token}`;
      const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
      if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
        const mailer = nodemailer.createTransport({
          host: SMTP_HOST,
          port: Number(SMTP_PORT) || 587,
          secure: Number(SMTP_PORT) === 465, // 465 = implicit TLS, 587 = STARTTLS
          auth: { user: SMTP_USER, pass: SMTP_PASS },
          // SMTP down/unreachable ho to request 2 min tak hang na ho:
          connectionTimeout: 15000,
          greetingTimeout: 15000,
          socketTimeout: 20000,
        });
        await mailer.sendMail({
          from: SMTP_FROM || SMTP_USER,
          to: user.email,
          subject: 'QUMS Attendance Bot — password reset',
          text: `Password reset link (1 hour valid):\n${link}`,
          html: `<p>Password reset link (1 hour valid):</p><p><a href="${link}">${link}</a></p>`,
        });
        console.log(`[auth] reset email sent -> ${user.email}`);
      } else if (IS_PROD) {
        // Production + no SMTP: token links ko logs me expose NAHI karte.
        console.error('[auth] SMTP configured nahi hai — password-reset link deliver nahi hoga.');
        console.error('[auth] Fix: Render env me SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS set karo (email delivery).');
      } else {
        // Dev-only convenience: bina SMTP ke link console me (local testing).
        console.log(`\n[auth] PASSWORD RESET LINK for ${user.email} (1h valid):\n${link}\n`);
      }
    }
    res.json({
      ok: true,
      message: 'Agar ye email registered hai to reset link bana diya gaya hai. (SMTP configured ho to email aayega, warna server console me link print hota hai.)',
    });
  } catch (err) {
    safeServerError(res, err);
  }
});

app.post('/api/reset', rateLimit('/api/reset'), async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password || String(password).length < 6) {
      return res.status(400).json({ error: 'Token + new password (min 6 chars) chahiye.' });
    }
    const user = db.consumeResetToken(token);
    if (!user) return res.status(400).json({ error: 'Reset link invalid ya expire ho gaya hai.' });
    const passwordHash = await bcrypt.hash(String(password), 10);
    db.updateUser(user.id, { passwordHash });
    console.log(`[auth] password reset done -> ${user.email}`);
    res.json({ ok: true, redirect: '/login' });
  } catch (err) {
    safeServerError(res, err);
  }
});

// ---- protected data APIs (per-user) ----
app.get('/api/me', requireAuth, (req, res) => {
  const user = db.getUserById(req.session.userId);
  res.json({
    email: user.email,
    qumsQid: user.qumsQid || '',
    qumsConfigured: Boolean(user.qumsSessionPath),
    telegramConnected: Boolean(user.telegramChatId),
    telegramConfigured: telegram.isConfigured(),
  });
});

app.get('/api/attendance', requireAuth, async (req, res) => {
  try {
    const runtime = resolveUserRuntime(req.appUser);
    const overrideTotal = Number(req.query.total);
    const subjects = await scrapeAttendance({ sessionPath: runtime.sessionPath });
    const analysis = analyzeAttendance(
      subjects,
      Number.isFinite(overrideTotal) && overrideTotal > 0 ? overrideTotal : undefined
    );
    res.json(analysis);
  } catch (err) {
    res.status(httpStatusFor(err)).json({ error: err.message, hint: err.hint || null, code: err.name });
  }
});

app.get('/api/today', requireAuth, async (req, res) => {
  // Debug aid: shows exactly what the watcher polls for THIS user.
  try {
    const runtime = resolveUserRuntime(req.appUser);
    const periods = await scrapeTodaysAttendance({ sessionPath: runtime.sessionPath });
    res.json({ date: new Date().toISOString(), periods });
  } catch (err) {
    res.status(httpStatusFor(err)).json({ error: err.message, hint: err.hint || null, code: err.name });
  }
});

/** Accurate Telegram-blocker error (token missing vs not-linked confuse na ho). */
function telegramSendBlockError(userId) {
  const reason = telegram.sendBlockerReason(userId);
  if (reason === 'not-configured') {
    return Object.assign(new Error('Telegram token set nahi hai (.env: TELEGRAM_BOT_TOKEN) — BotFather ka token daal ke server restart karo.'), { name: 'TelegramNotConfigured' });
  }
  if (reason === 'bot-not-initialized') {
    return Object.assign(new Error('Telegram polling start nahi hua — server restart karo (token .env me hone ke baad).'), { name: 'TelegramNotConfigured' });
  }
  return Object.assign(new Error('Telegram linked nahi hai — pehle dashboard se "Connect Telegram" karo.'), { name: 'TelegramNotLinked' });
}

app.all('/api/trigger-telegram', requireAuth, async (req, res) => {
  try {
    const runtime = resolveUserRuntime(req.appUser);
    const subjects = await scrapeAttendance({ sessionPath: runtime.sessionPath });
    const analysis = analyzeAttendance(subjects);
    const preview = formatAttendanceMessage(analysis);
    const sent = await sendMessage(req.appUser.id, preview);
    if (!sent) throw telegramSendBlockError(req.appUser.id);
    res.json({ success: true, sentTo: req.appUser.email, preview });
  } catch (err) {
    res.status(httpStatusFor(err)).json({ error: err.message, hint: err.hint || null, code: err.name });
  }
});

// ---- QUMS web login (HEADLESS captcha relay — koi visible window nahi) ----
app.post('/api/qums-login/start', requireAuth, async (req, res) => {
  try {
    const { qid, password } = req.body || {};
    // credsOverride sirf FIRST-TIME setup ke liye (frontend inputs). Reconnect
    // me undefined -> qums-login DB se decrypt karke auto-fill karta hai.
    const result = await qumsLogin.startQumsLogin(
      req.session.userId,
      qid && password ? { qid, password } : undefined
    );
    res.json(result); // { ok: true, captchaImage }
  } catch (err) {
    res.status(httpStatusFor(err)).json({ error: err.message, hint: err.hint || null, code: err.name });
  }
});

app.post('/api/qums-login/submit-captcha', requireAuth, async (req, res) => {
  try {
    const { captchaText, captcha } = req.body || {};
    const result = await qumsLogin.submitQumsCaptcha(req.session.userId, captchaText || captcha);
    if (result && result.ok) {
      // Task 3: setup complete hote hi TURANT baseline — aaj ke MARKED periods
      // ko dedupe states me seed karo (N.M. skip). Isse (a) already-marked
      // periods ka alert-storm nahi hoga, (b) baaki bache periods pe marks
      // hone par alert USI DIN se aayega. Fire-and-forget (API ko block na kare).
      runBaselineForUser(req.session.userId).catch((e) =>
        console.error('[qums-setup] baseline fetch fail:', e.message)
      );
    }
    res.json(result); // { ok: true, sessionPath } ya { ok: false, error, captchaImage }
  } catch (err) {
    res.status(httpStatusFor(err)).json({ error: err.message, hint: err.hint || null, code: err.name });
  }
});

// ---- QUMS logout (manual) — session delete; creds DB me rehte hain (Reconnect sirf captcha) ----
app.post('/api/qums-logout', requireAuth, (req, res) => {
  try {
    const sp = req.appUser.qumsSessionPath;
    if (sp && fs.existsSync(sp)) {
      try { fs.unlinkSync(sp); } catch {}
    }
    db.updateUser(req.appUser.id, { qumsSessionPath: '' });
    res.json({
      ok: true,
      message: 'QUMS logout — session delete ho gayi. Reconnect karne ke liye QUMS Setup → "Reconnect QUMS" (sirf captcha).',
    });
  } catch (err) {
    safeServerError(res, err);
  }
});

app.all('/api/scheduler/run', requireAuth, async (req, res) => {
  // manual test trigger for the logged-in user's jobs (uses THEIR runtime creds)
  // (GET + POST dono chalte hain — dashboard buttons ke liye)
  try {
    const morning = req.query.morning === '1';
    const runtime = resolveUserRuntime(req.appUser);
    if (morning) {
      const { text } = await getMorningScheduleText(req.appUser); // cache-first merged
      const sent = await sendMessage(req.appUser.id, text);
      if (!sent) throw telegramSendBlockError(req.appUser.id);
      res.json({ success: true, message: 'Morning schedule message sent (aaj ki classes).' });
    } else {
      const subjects = await scrapeAttendance({ sessionPath: runtime.sessionPath });
      const analysis = analyzeAttendance(subjects);
      const sent = await sendMessage(req.appUser.id, formatAttendanceMessage(analysis));
      if (!sent) throw telegramSendBlockError(req.appUser.id);
      res.json({ success: true, message: '9 PM-style summary sent.' });
    }
  } catch (err) {
    res.status(httpStatusFor(err)).json({ error: err.message, hint: err.hint || null, code: err.name });
  }
});

// ---- Task 2: "Refresh my schedule" — weekly cache force-refresh (live merge) ----
app.post('/api/schedule/refresh', requireAuth, async (req, res) => {
  try {
    const { text, mode } = await getMorningScheduleText(req.appUser, { forceRefresh: true });
    const periods = (text.match(/^\d+\./gm) || []).length;
    res.json({ success: true, mode, message: `Schedule refreshed (${periods} periods, source: ${mode}).` });
  } catch (err) {
    res.status(httpStatusFor(err)).json({ error: err.message, hint: err.hint || null, code: err.name });
  }
});

// ---- Telegram linking (deep-link flow — koi QR nahi) ----
app.get('/api/telegram/status', requireAuth, (req, res) => {
  const code = db.telegramLinkCodeFor(req.appUser.id);
  res.json({
    configured: telegram.isConfigured(),
    connected: Boolean(req.appUser.telegramChatId),
    botUsername: telegram.getBotUsername(),
    linkUrl: telegram.deepLink(code),
  });
});

app.post('/api/telegram/unlink', requireAuth, (req, res) => {
  db.clearTelegramChatId(req.appUser.id);
  res.json({ ok: true, message: 'Telegram disconnected. Dobara connect karne ke liye "Connect Telegram" dabao.' });
});

// ---- misc ----
// Health check — simple, secret-free: user counts / telegram state / internals
// PUBLIC endpoint pe leak nahi karte. Render Health Check Path isi ko point karo.
app.get('/health', (req, res) => {
  res.json({ ok: true, status: 'ok', uptimeSeconds: Math.round(process.uptime()), timestamp: new Date().toISOString() });
});

app.use(express.static(PUBLIC_DIR));

// ---- API fallbacks: kabhi bhi HTML API clients tak na jaaye ----
app.use('/api', (req, res) => {
  res.status(404).json({ error: `Unknown API route: ${req.method} ${req.originalUrl}` });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[server] unhandled error:', err.name || 'Error', '-', err.message);
  if (!IS_PROD && err.stack) console.error(err.stack); // stack sirf dev logs me
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({ error: IS_PROD ? 'Server error. Thodi der baad try karo.' : 'Server error: ' + err.message });
  }
  res.status(500).send('Server error');
});

// ---- process-level resilience: scheduler/watcher zinda rahen, chhote errors pe crash nahi ----
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection:', reason && reason.message ? `${reason.name || 'Error'}: ${reason.message}` : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException:', err.name || 'Error', '-', err.message);
});

// ---- boot ----
startScheduler();
startWatcher();
telegram.initTelegram();

app.listen(PORT, () => {
  console.log(`[server] QUMS Attendance Bot (multi-user) running at ${BASE_URL}`);
  console.log(`[server] (listening on 0.0.0.0:${PORT}${IS_PROD ? ', production mode' : ', development mode'})`);
  console.log('[server] Pages: /register /login /dashboard /qums-setup /forgot /reset');
  console.log('[server] APIs: /api/attendance | /api/today | /api/trigger-telegram | /health');
  console.log('[server] Scheduler: 8:30 AM (aaj ki classes) + 9 PM (attendance summary) — saare users');
  console.log('[server] Watcher: per-class alerts, college hours 08:30-17:00 IST + backdated month-register loop');
  if (!telegram.isConfigured()) {
    console.log('[server] Telegram: DISABLED — TELEGRAM_BOT_TOKEN set karo (Render env ya .env) aur restart; bina iske server theek chalega.');
  }
});
