import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const authSessionValid = new Rate(
  'auth_session_valid'
);

/*
 * Cliente de autenticación compartido por los escenarios GeoSuite.
 *
 * Implementa Authorization Code con PKCE a través de NextAuth y Keycloak,
 * conserva las cookies recibidas y valida el access token contra un endpoint
 * protegido de Django/GeoNode. El diagnóstico nunca imprime valores de
 * credenciales, cookies o tokens.
 *
 * En perfiles de carga se invocará una vez por VU y se reutilizará la sesión.
 */

function required(name) {
  const value = __ENV[name];

  if (!value) {
    fail(`La variable ${name} es obligatoria`);
  }

  return value;
}

function parseJson(response) {
  try {
    return response.json();
  } catch (_) {
    return null;
  }
}

function captureCookies(response, store) {
  for (const name of Object.keys(response.cookies || {})) {
    const values = response.cookies[name];

    if (Array.isArray(values) && values.length > 0) {
      store[name] = values[values.length - 1].value;
    }
  }
}

function cookieHeader(store) {
  return Object.entries(store)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function absoluteUrl(location, currentUrl) {
  if (/^https?:\/\//i.test(location)) {
    return location;
  }

  const origin = currentUrl.match(
    /^(https?:\/\/[^/]+)/
  )?.[1];

  if (!origin) {
    return location;
  }

  if (location.startsWith('/')) {
    return `${origin}${location}`;
  }

  const directory = currentUrl.replace(
    /\/[^/]*(?:\?.*)?$/,
    '/'
  );

  return `${directory}${location}`;
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&#x2F;/gi, '/')
    .replace(/&#x3A;/gi, ':')
    .replace(/&#x3D;/gi, '=')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function loginFormAction(html) {
  const form = String(html || '').match(
    /<form[^>]*id=["']kc-form-login["'][^>]*>/i
  );

  if (!form) {
    return '';
  }

  const action = form[0].match(
    /action=["']([^"']+)["']/i
  );

  return action ? decodeHtml(action[1]) : '';
}

function followRedirects(response, cookies, limit) {
  let currentUrl = response.url;

  for (let index = 0; index < limit; index += 1) {
    captureCookies(response, cookies);

    if (
      ![301, 302, 303, 307, 308].includes(
        response.status
      )
    ) {
      return response;
    }

    const location = String(
      response.headers.Location || ''
    );

    if (!location) {
      return response;
    }

    const nextUrl = absoluteUrl(location, currentUrl);

    response = http.get(nextUrl, {
      redirects: 0,
      headers: {
        Cookie: cookieHeader(cookies),
      },
      tags: {
        scenario: 'auth',
        operation: 'follow_redirect',
      },
    });

    currentUrl = nextUrl;
  }

  return response;
}

export function authenticate(credentials = null) {
  const baseUrl = required('BASE_URL');
  const issuer = required('OIDC_ISSUER');
  const clientId = required('KEYCLOAK_CLIENT_ID');

  const csrfPath = required('AUTH_CSRF_PATH');
  const signinPath = required('AUTH_SIGNIN_PATH');
  const sessionPath = required('AUTH_SESSION_PATH');
  const callbackUrl = required('AUTH_CALLBACK_URL');
  const protectedPath = required(
    'AUTH_PROTECTED_PATH'
  );

  const username = credentials?.username ||
    required('AUTH_USERNAME');
  const password = credentials?.password ||
    required('AUTH_PASSWORD');

  const cookies = {};

  // 1. Protección CSRF de NextAuth.
  const csrfResponse = http.get(
    `${baseUrl}${csrfPath}`,
    {
      redirects: 0,
      tags: {
        scenario: 'auth',
        operation: 'get_csrf',
      },
    }
  );

  captureCookies(csrfResponse, cookies);

  const csrfData = parseJson(csrfResponse);
  const csrfToken = String(
    csrfData?.csrfToken || ''
  );

  const csrfCookie = String(
    cookies['__Host-next-auth.csrf-token'] ||
      cookies['next-auth.csrf-token'] ||
      ''
  );

  const csrfValid = check(csrfResponse, {
    'auth: CSRF HTTP 200': (res) =>
      res.status === 200,

    'auth: CSRF JSON válido': () =>
      csrfData !== null,

    'auth: token CSRF presente': () =>
      csrfToken.length > 0,

    'auth: cookie CSRF presente': () =>
      csrfCookie.length > 0,
  });

  if (!csrfValid) {
    fail('No fue posible obtener la protección CSRF');
  }

  sleep(1);

  // 2. Inicio de Authorization Code con PKCE.
  const signinResponse = http.post(
    `${baseUrl}${signinPath}`,
    {
      csrfToken,
      callbackUrl: `${baseUrl}${callbackUrl}`,
    },
    {
      redirects: 0,
      headers: {
        Cookie: cookieHeader(cookies),
      },
      tags: {
        scenario: 'auth',
        operation: 'start_oidc',
      },
    }
  );

  captureCookies(signinResponse, cookies);

  const authorizationUrl = String(
    signinResponse.headers.Location || ''
  );

  const signinValid = check(signinResponse, {
    'auth: inicio devuelve redirección': (res) =>
      [302, 303].includes(res.status),

    'auth: redirección al issuer': () =>
      authorizationUrl.startsWith(issuer),

    'auth: endpoint de autorización': () =>
      authorizationUrl.includes(
        '/protocol/openid-connect/auth'
      ),

    'auth: client_id correcto': () =>
      authorizationUrl.includes(
        `client_id=${encodeURIComponent(clientId)}`
      ),

    'auth: authorization code': () =>
      authorizationUrl.includes(
        'response_type=code'
      ),

    'auth: PKCE S256': () =>
      authorizationUrl.includes(
        'code_challenge_method=S256'
      ),
  });

  if (!signinValid) {
    fail('GeoSuite no inició correctamente el flujo OIDC');
  }

  sleep(1);

  // 3. Formulario de Keycloak.
  let loginPage = http.get(authorizationUrl, {
    redirects: 0,
    headers: {
      Cookie: cookieHeader(cookies),
    },
    tags: {
      scenario: 'auth',
      operation: 'open_keycloak_login',
    },
  });

  loginPage = followRedirects(
    loginPage,
    cookies,
    5
  );

  captureCookies(loginPage, cookies);

  const formAction = loginFormAction(loginPage.body);

  const loginPageValid = check(loginPage, {
    'auth: formulario Keycloak HTTP 200': (res) =>
      res.status === 200,

    'auth: formulario HTML': (res) =>
      String(res.headers['Content-Type'] || '')
        .toLowerCase()
        .includes('text/html'),

    'auth: campo username presente': (res) =>
      String(res.body || '')
        .includes('name="username"'),

    'auth: campo password presente': (res) =>
      String(res.body || '')
        .includes('name="password"'),

    'auth: acción del formulario presente': () =>
      formAction.length > 0,
  });

  if (!loginPageValid) {
    fail('No fue posible abrir el formulario de Keycloak');
  }

  sleep(1);

  // 4. Envío de credenciales.
  const credentialsResponse = http.post(
    formAction,
    {
      username,
      password,
      credentialId: '',
    },
    {
      redirects: 0,
      headers: {
        Cookie: cookieHeader(cookies),
      },
      tags: {
        scenario: 'auth',
        operation: 'submit_credentials',
      },
    }
  );

  captureCookies(credentialsResponse, cookies);

  const callbackLocation = String(
    credentialsResponse.headers.Location || ''
  );

  const credentialsValid = check(
    credentialsResponse,
    {
      'auth: credenciales generan redirección':
        (res) => [302, 303].includes(res.status),

      'auth: redirección contiene callback':
        () =>
          callbackLocation.includes(
            '/admin/api/auth/callback/keycloak'
          ),

      'auth: callback contiene code': () =>
        callbackLocation.includes('code='),

      'auth: callback contiene state': () =>
        callbackLocation.includes('state='),
    }
  );

  if (!credentialsValid) {
    fail(
      'Keycloak rechazó las credenciales o requiere otra acción'
    );
  }

  sleep(1);

  // 5. Callback de NextAuth.
  const callbackResponse = http.get(
    callbackLocation,
    {
      redirects: 0,
      headers: {
        Cookie: cookieHeader(cookies),
      },
      tags: {
        scenario: 'auth',
        operation: 'oidc_callback',
      },
    }
  );

  const finalResponse = followRedirects(
    callbackResponse,
    cookies,
    5
  );

  captureCookies(finalResponse, cookies);

  const callbackValid = check(finalResponse, {
    'auth: callback finaliza sin error HTTP':
      (res) => res.status >= 200 && res.status < 400,

    'auth: no termina en error de autenticación':
      (res) =>
        !String(res.url || '')
          .includes('/api/auth/error'),
  });

  if (!callbackValid) {
    fail('El callback OIDC no finalizó correctamente');
  }

  sleep(1);

  // 6. Sesión de NextAuth.
  const sessionResponse = http.get(
    `${baseUrl}${sessionPath}`,
    {
      redirects: 0,
      headers: {
        Cookie: cookieHeader(cookies),
      },
      tags: {
        scenario: 'auth',
        operation: 'get_session',
      },
    }
  );

  const sessionData = parseJson(sessionResponse);
  const accessToken = String(
    sessionData?.accessToken || ''
  );

  const sessionValid = check(sessionResponse, {
    'auth: sesión HTTP 200': (res) =>
      res.status === 200,

    'auth: sesión JSON válida': () =>
      sessionData !== null,

    'auth: usuario presente': () =>
      Boolean(sessionData?.user),

    'auth: access token presente': () =>
      accessToken.length > 0,

    'auth: sesión sin error de refresh': () =>
      !sessionData?.error,
  });

  authSessionValid.add(sessionValid);

  if (!sessionValid) {
    // Diagnóstico seguro: no imprime valores de cookies, credenciales ni tokens.
    console.error(
      '[auth] sesión inválida: ' +
      `callback_url=${finalResponse.url}, ` +
      `cookie_names=${Object.keys(cookies).join(',') || 'ninguna'}, ` +
      `session_keys=${Object.keys(sessionData || {}).join(',') || 'ninguna'}`
    );
    fail('NextAuth no creó una sesión válida');
  }

  sleep(1);

  // 7. Validación en Django/GeoNode.
  const protectedResponse = http.get(
    `${baseUrl}${protectedPath}`,
    {
      redirects: 0,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      tags: {
        scenario: 'auth',
        operation: 'validate_django_token',
      },
    }
  );

  const profileData = parseJson(protectedResponse);

  const protectedValid = check(
    protectedResponse,
    {
      'auth: Django/GeoNode HTTP 200': (res) =>
        res.status === 200,

      'auth: Django/GeoNode devuelve JSON':
        (res) =>
          String(res.headers['Content-Type'] || '')
            .toLowerCase()
            .includes('application/json'),

      'auth: perfil JSON válido': () =>
        profileData !== null,

      'auth: perfil contiene email': () =>
        profileData !== null &&
        typeof profileData === 'object' &&
        Object.prototype.hasOwnProperty.call(
          profileData,
          'email'
        ),
    }
  );

  if (!protectedValid) {
    fail(
      'Django/GeoNode no aceptó el token de Keycloak'
    );
  }

  return {
    accessToken,
    cookieHeader: cookieHeader(cookies),
    sessionData,
  };
}
