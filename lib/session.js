import { authenticate } from './auth.js';
import exec from 'k6/execution';
import { fail } from 'k6';
import { selectedProfile } from './profiles.js';

const USERS_FILE = String(
  __ENV.AUTH_USERS_FILE || ''
).trim();

let userPool = [];

if (USERS_FILE) {
  try {
    const parsed = JSON.parse(open(USERS_FILE));

    if (!Array.isArray(parsed)) {
      throw new Error('el contenido no es un arreglo');
    }

    userPool = parsed.filter(
      (user) =>
        typeof user?.username === 'string' &&
        user.username.length > 0 &&
        typeof user?.password === 'string' &&
        user.password.length > 0
    );

    if (userPool.length !== parsed.length) {
      throw new Error('existen entradas incompletas');
    }
  } catch (error) {
    throw new Error(
      `AUTH_USERS_FILE no es válido: ${error.message}`
    );
  }
}

/*
 * Cada VU de k6 dispone de su propio runtime y, por tanto, de esta caché.
 * La primera iteración autentica al usuario; las posteriores reutilizan la
 * sesión del mismo VU. El escenario 01 no usa esta función porque mide login.
 */
let cachedSession = null;

export function credentialsForVu() {
  if (userPool.length === 0) {
    if (selectedProfile() !== 'functional') {
      fail(
        'Los perfiles concurrentes autenticados requieren AUTH_USERS_FILE'
      );
    }

    return null;
  }

  const vuId = exec.vu.idInTest;

  if (vuId > userPool.length) {
    fail(
      `No hay suficientes usuarios: VU=${vuId}, ` +
      `pool=${userPool.length}`
    );
  }

  return userPool[vuId - 1];
}

export function authenticatedSession() {
  if (!cachedSession) {
    cachedSession = authenticate(
      credentialsForVu()
    );
  }

  return cachedSession;
}
