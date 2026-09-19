/**
 * mailer — forgot-password email delivery.
 *
 * Provider priority (pehla jo configured ho wahi use hota hai):
 *   1. RESEND_API_KEY           -> Resend API (RECOMMENDED — koi SMTP server nahi chahiye)
 *   2. SMTP_HOST/USER/PASS      -> nodemailer (Gmail App Password etc.) — fallback
 *   3. warna 'console'          -> bina provider ke (local dev me server route khud
 *                                  link print karta hai; PRODUCTION me link kabhi
 *                                  logs me expose NAHI hota)
 *
 * RESEND setup (ek baar):
 *   1. resend.com -> API Keys -> "Create API Key" (re_...) -> .env: RESEND_API_KEY
 *   2. FREE-TIER NOTE: default from (`onboarding@resend.dev`) se email sirf APNE
 *      khud ke Resend-account wale email pe jaayega.
 *   3. PRODUCTION: Resend dashboard -> Domains -> apna domain verify karo ->
 *      .env: RESEND_FROM=QUMS Attendance Bot <noreply@yourdomain.com>
 *
 * NOTE: API-key MANAGEMENT (create/list/update/delete keys) resend.com dashboard
 * ka kaam hai — server code me sirf EXISTING key use hoti hai (doosri key se
 * keys banana server me security anti-pattern hai).
 *
 * SAFE LOGS: RESEND_API_KEY / SMTP_PASS / full email content KABHI log nahi hota.
 */
require('dotenv').config();

const RESEND_FROM_DEFAULT = 'QUMS Attendance Bot <onboarding@resend.dev>';

/** Pure: kaunsa provider active hai? -> 'resend' | 'smtp' | 'console' */
function mailerProvider(env = process.env) {
  if (String(env.RESEND_API_KEY || '').trim()) return 'resend';
  if (env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS) return 'smtp';
  return 'console';
}

/** Pure: nodemailer transport config (null agar SMTP configured nahi). */
function smtpConfig(env = process.env) {
  if (!(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS)) return null;
  return {
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT) || 587,
    secure: Number(env.SMTP_PORT) === 465, // 465 = implicit TLS, 587 = STARTTLS
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    // SMTP down/unreachable ho to request hang na ho:
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  };
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Pure: password-reset email ka content (subject/text/html). */
function buildResetEmail(link) {
  const safeLink = escapeHtml(link);
  return {
    subject: 'QUMS Attendance Bot — password reset',
    text: `Password reset link (1 hour valid):\n${link}\n\nAgar aapne ye request nahi ki thi, is email ko ignore karo — aapka password waise hi rahega.`,
    html:
      `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #eee;border-radius:8px;">` +
      `<h2 style="margin:0 0 12px;color:#1a2b4c;">QUMS Attendance Bot</h2>` +
      `<p style="margin:0 0 16px;">Password reset link (1 hour valid):</p>` +
      `<p style="margin:0 0 16px;"><a href="${safeLink}" style="display:inline-block;background:#1a2b4c;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;">Reset password</a></p>` +
      `<p style="margin:0;color:#666;font-size:12px;word-break:break-all;">Link: ${safeLink}</p>` +
      `<p style="margin:12px 0 0;color:#666;font-size:12px;">Agar aapne ye request nahi ki thi, is email ko ignore karo — aapka password waise hi rahega.</p>` +
      `</div>`,
  };
}

/**
 * Resend API se send. deps.ResendImpl tests ke liye inject hota hai (fake client).
 * SDK v6 return: { data: { id } | null, error: { message } | null } — API error
 * throw NAHI hota SDK me, isliye error object khud handle karte hain.
 */
async function sendViaResend(payload, deps = {}) {
  const apiKey = String(deps.apiKey || process.env.RESEND_API_KEY || '').trim();
  const ResendImpl = deps.ResendImpl || require('resend').Resend;
  const from = deps.from || process.env.RESEND_FROM || RESEND_FROM_DEFAULT;
  const resend = new ResendImpl(apiKey);
  const result = await resend.emails.send({ ...payload, from });
  if (result && result.error) {
    throw new Error(result.error.message || 'Resend send failed');
  }
  return { ok: true, via: 'resend', id: result && result.data ? result.data.id : null };
}

/** SMTP (nodemailer) se send — purana fallback path. */
async function sendViaSmtp(payload, deps = {}) {
  const nodemailer = require('nodemailer');
  const cfg = smtpConfig();
  if (!cfg) throw new Error('SMTP configured nahi hai (SMTP_HOST/SMTP_USER/SMTP_PASS missing)');
  const transport = deps.transportFactory ? deps.transportFactory(cfg) : nodemailer.createTransport(cfg);
  await transport.sendMail({ ...payload, from: process.env.SMTP_FROM || process.env.SMTP_USER });
  return { ok: true, via: 'smtp' };
}

/**
 * Unified send — kabhi THROW nahi karta, hamesha { ok, via, error? } return karta
 * hai (caller [server /api/forgot] decide kare kya karna hai). deps: tests ke
 * liye { ResendImpl, transportFactory, from, log }.
 */
async function sendMail({ to, subject, text, html }, deps = {}) {
  const log = deps.log || console;
  const payload = { to, subject, text, html };
  const provider = mailerProvider();
  try {
    if (provider === 'resend') {
      const r = await sendViaResend(payload, deps);
      log.log(`[mailer] reset email sent via Resend -> ${to}`);
      return r;
    }
    if (provider === 'smtp') {
      const r = await sendViaSmtp(payload, deps);
      log.log(`[mailer] reset email sent via SMTP -> ${to}`);
      return r;
    }
    log.log('[mailer] koi email provider configured nahi (RESEND_API_KEY / SMTP_*) — caller ko bataya.');
    return { ok: false, via: 'console', error: 'no-provider-configured' };
  } catch (err) {
    log.error(`[mailer] send FAILED via ${provider} for ${to}: ${err.message}`);
    return { ok: false, via: provider, error: err.message };
  }
}

module.exports = {
  sendMail,
  sendViaResend,
  sendViaSmtp,
  mailerProvider,
  smtpConfig,
  buildResetEmail,
  RESEND_FROM_DEFAULT,
};
