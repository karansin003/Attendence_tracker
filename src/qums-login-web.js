/**
 * Web-based QUMS login (multi-user) — HEADLESS captcha relay.
 *
 * Koi visible browser window nahi khulti — deployment-safe (VPS pe bhi chalta
 * hai jahan display nahi hota). Captcha image dashboard pe dikhti hai:
 *   1. POST /api/qums-login/start
 *      -> headless Chromium login page kholta hai, QID+password auto-fill
 *         (RECONNECT: DB se decrypt karke — user ko dobara nahi poochha jaata;
 *          FIRST-TIME: frontend se aaye creds use + success pe encrypted save),
 *         captcha ka screenshot (base64) return karta hai (browser alive rehta hai)
 *   2. POST /api/qums-login/submit-captcha { captchaText }
 *      -> captcha fill + Login click + URL-change wait; success pe session
 *         data/qums-sessions/<userId>.json me save + browser dispose.
 *         Galat captcha -> page reload + FRESH captcha image return (retry).
 *
 * Pending login 5 min me auto-expires (browser close).
 */
require('dotenv').config();
const { chromium } = require('playwright');
const db = require('./db');
const { encryptSecret } = require('./crypto');
const {
  isLoginLikeUrl,
  findLoginForm,
  autofillCredentials,
  locateCaptchaInput,
  clickLoginButton,
  captureCaptchaImage,
} = require('./login');

const LOGIN_URL =
  process.env.QUMS_LOGIN_URL || 'https://qums.quantumuniversity.edu.in/';
const PENDING_TTL_MS = 5 * 60 * 1000; // 5 min to solve the captcha

/** userId -> { browser, context, page, frame, startedAt, timer } */
const pending = new Map();

async function disposePending(userId) {
  const p = pending.get(userId);
  if (!p) return;
  pending.delete(userId);
  if (p.timer) clearTimeout(p.timer);
  try {
    await p.browser.close();
  } catch {}
}

async function openLoginFormPage() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500); // JS-rendered form settle
  const frame = await findLoginForm(page);
  return { browser, context, page, frame };
}

async function captureCaptchaFor(pendingLogin) {
  const image = await captureCaptchaImage(pendingLogin.page, pendingLogin.frame);
  pendingLogin.captchaImage = image;
  return image;
}

/**
 * Step 1: login page kholo (HEADLESS — koi visible window nahi), creds
 * auto-fill karo, captcha ka screenshot (base64) return karo.
 *
 * credsOverride ({ qid, password }) sirf FIRST-TIME setup ke liye — frontend
 * inputs se aata hai. RECONNECT me credsOverride NAHI do: DB se decrypt karke
 * auto-fill hota hai, user ko QID/password dobara nahi poochhe jaate.
 */
async function startQumsLogin(userId, credsOverride, log = console) {
  let qid;
  let password;
  const user = db.getUserById(userId);
  if (credsOverride && credsOverride.qid && credsOverride.password) {
    qid = String(credsOverride.qid).trim();
    password = String(credsOverride.password);
  } else {
    if (!user || !user.qumsQid || !user.qumsPasswordEncrypted) {
      const e = new Error('QID/Password DB me saved nahi hain — pehli baar setup me QID + password daalo.');
      e.name = 'QumsCredsMissing';
      e.hint = 'Pehli baar setup: QID + password fields dikhao. Reconnect: pehle ek baar setup complete hona chahiye.';
      throw e;
    }
    qid = user.qumsQid;
    password = decryptStored(user); // DB se decrypt — frontend se kabhi nahi
    if (!password) {
      const e = new Error('QUMS password decrypt nahi hua (ENCRYPTION_KEY galat/change ho gaya?).');
      e.name = 'DecryptError';
      e.hint = 'ENCRYPTION_KEY check karo — ya QID + password dobara daal ke setup complete karo.';
      throw e;
    }
  }

  await disposePending(userId); // koi purana pending ho to clean
  const { browser, context, page, frame } = await openLoginFormPage();
  try {
    await autofillCredentials(frame, qid, password);
    // qid/password sirf IN-MEMORY pending object me rakhte hain (captcha-retry
    // ke liye) — kabhi disk pe plain store nahi karte.
    const pendingLogin = {
      browser,
      context,
      page,
      frame,
      startedAt: Date.now(),
      qid: String(qid || '').trim(),
      password: String(password || ''),
    };
    const captchaImage = await captureCaptchaFor(pendingLogin);
    pendingLogin.timer = setTimeout(() => {
      log.log(`[qums-login] pending login timeout for user ${userId} — browser close.`);
      disposePending(userId);
    }, PENDING_TTL_MS);
    pending.set(userId, pendingLogin);
    return { ok: true, captchaImage };
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

/** Step 2: submit the captcha; success -> per-user session file + DB update. */
async function submitQumsCaptcha(userId, captchaText, log = console) {
  const p = pending.get(userId);
  if (!p) {
    const e = new Error('No pending QUMS login — captcha dobara generate karo.');
    e.name = 'NoPendingLogin';
    e.hint = 'Captcha 5 min me expire ho jata hai. Start Login dobara dabao.';
    throw e;
  }

  const captchaInput = await locateCaptchaInput(p.frame);
  await captchaInput.fill(String(captchaText || '').trim());
  await clickLoginButton(p.frame);

  try {
    await p.page.waitForURL((url) => !isLoginLikeUrl(url.toString()), { timeout: 30000 });
  } catch {
    // login fail (galat captcha / timeout) — fresh login page + FRESH captcha
    const { browser, context, page, frame } = await openLoginFormPage();
    await autofillCredentials(frame, p.qid, p.password);
    await p.browser.close().catch(() => {});
    const newPending = {
      browser,
      context,
      page,
      frame,
      startedAt: Date.now(),
      qid: p.qid,
      password: p.password,
    };
    const captchaImage = await captureCaptchaFor(newPending);
    newPending.timer = setTimeout(() => {
      log.log(`[qums-login] pending login timeout for user ${userId} — browser close.`);
      disposePending(userId);
    }, PENDING_TTL_MS);
    pending.set(userId, newPending);
    return {
      ok: false,
      error: 'Captcha galat lagii ya login nahi hua — nayi captcha le lo, dobara try karo.',
      captchaImage,
    };
  }

  await p.page.waitForTimeout(2000); // post-login JS settle
  const sessionPath = db.sessionPathFor(userId);
  await p.context.storageState({ path: sessionPath });
  await disposePending(userId);

  // Persist QID + encrypted password + session path — setup COMPLETE.
  completeQumsSetup(userId, p.qid, p.password);
  log.log(`[qums-login] QUMS session saved for user ${userId} -> ${sessionPath}`);
  return { ok: true, sessionPath };
}

/** helper: decrypt stored password (only needed for legacy re-use) */
function decryptStored(user) {
  const { decryptSecret } = require('./crypto');
  return decryptSecret(user.qumsPasswordEncrypted) || '';
}

/** Persist qid + encrypted password + session path for the user. */
function completeQumsSetup(userId, qid, plainPassword) {
  return db.updateUser(userId, {
    qumsQid: String(qid || '').trim(),
    qumsPasswordEncrypted: encryptSecret(plainPassword),
    qumsSessionPath: db.sessionPathFor(userId),
  });
}

function hasPendingLogin(userId) {
  return pending.has(userId);
}

module.exports = {
  startQumsLogin,
  submitQumsCaptcha,
  completeQumsSetup,
  hasPendingLogin,
  disposePending,
};
