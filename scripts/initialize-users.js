import { check } from 'k6';
import exec from 'k6/execution';
import { authenticate } from '../lib/auth.js';

/*
 * Inicializa los perfiles GeoSuite de las cuentas aprovisionadas en Keycloak.
 * Un solo VU recorre el pool y ejecuta exactamente un login OIDC por cuenta.
 * La ejecución secuencial evita convertir la preparación en prueba de carga.
 */

const usersFile = String(__ENV.AUTH_USERS_FILE || '').trim();

if (!usersFile) {
  throw new Error('AUTH_USERS_FILE es obligatorio');
}

let users;

try {
  users = JSON.parse(open(usersFile));
} catch (error) {
  throw new Error(
    `No fue posible leer AUTH_USERS_FILE: ${error.message}`
  );
}

if (!Array.isArray(users) || users.length === 0) {
  throw new Error('El pool de usuarios está vacío');
}

const poolValid = users.every(
  (user) =>
    typeof user?.username === 'string' &&
    user.username.length > 0 &&
    typeof user?.password === 'string' &&
    user.password.length > 0
);

if (!poolValid) {
  throw new Error('El pool contiene credenciales incompletas');
}

export const options = {
  tags: {
    flow: 'initialize_users',
    test_profile: 'initialization',
  },
  scenarios: {
    initialize_users: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: users.length,
      maxDuration: '5m',
      gracefulStop: '30s',
    },
  },
  thresholds: {
    auth_session_valid: ['rate==1'],
    checks: ['rate==1'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const userIndex = exec.scenario.iterationInTest;
  const credentials = users[userIndex];

  check(credentials, {
    'inicialización: credencial asignada al VU':
      (value) => Boolean(value?.username),
  });

  authenticate(credentials);
}
