/**
 * Per-user runtime credential resolver.
 * DB user -> decrypted QUMS creds + session file.
 * Fallback (CLI/legacy): .env creds + root session_state.json.
 */
require('dotenv').config();
const path = require('path');
const { decryptSecret } = require('./crypto');

const ROOT_SESSION_FILE = path.join(__dirname, '..', 'session_state.json');

/**
 * user (DB row) -> { qid, password, sessionPath }
 * Throws with a helpful message if the user hasn't completed QUMS setup.
 */
function resolveUserRuntime(user) {
  if (!user) {
    // CLI / legacy fallback — pre-Phase-2 behaviour.
    const qid = process.env.QUMS_QID;
    const password = process.env.QUMS_PASSWORD;
    if (!qid || !password) {
      const e = new Error('No user session & no .env QUMS credentials.');
      e.name = 'NoSessionError';
      e.hint = 'Register + QUMS setup karo (/register), ya .env me QUMS_QID/QUMS_PASSWORD bharo.';
      throw e;
    }
    return {
      qid,
      password,
      sessionPath: ROOT_SESSION_FILE,
    };
  }

  const sessionPath = user.qumsSessionPath || '';
  if (!sessionPath || !user.qumsPasswordEncrypted || !user.qumsQid) {
    const e = new Error('QUMS setup incomplete for this user.');
    e.name = 'QumsSetupRequired';
    e.hint = 'Dashboard se QUMS Setup complete karo (QID + password + captcha).';
    throw e;
  }
  const password = decryptSecret(user.qumsPasswordEncrypted);
  if (!password) {
    const e = new Error('QUMS password decrypt nahi hua (ENCRYPTION_KEY galat/change ho gaya?).');
    e.name = 'DecryptError';
    e.hint = 'ENCRYPTION_KEY check karo, ya QUMS Setup dobara complete karo.';
    throw e;
  }
  return {
    qid: user.qumsQid,
    password,
    sessionPath,
  };
}

module.exports = { resolveUserRuntime, ROOT_SESSION_FILE };
