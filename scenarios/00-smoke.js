import http from 'k6/http';
import { check, fail } from 'k6';

/*
 * Escenario 00: comprobación mínima de disponibilidad.
 *
 * Consulta el listado público de recursos y valida estado, cuerpo y tipo de
 * contenido. Es de solo lectura y permite detectar fallos básicos de DNS,
 * Nginx o API antes de ejecutar escenarios más costosos.
 *
 * Requiere: BASE_URL.
 */

export const options = {
  vus: 1,
  iterations: 1,
};

export default function () {
  const baseUrl = __ENV.BASE_URL;

  if (!baseUrl) {
    fail('La variable BASE_URL es obligatoria');
  }

  const response = http.get(`${baseUrl}/api/v2/sigic-resources/`, {
    tags: {
      scenario: 'smoke',
      endpoint: 'sigic-resources',
    },
  });

  check(response, {
    'estado HTTP 200': (res) => res.status === 200,

    'respuesta no vacía': (res) =>
      Boolean(res.body && res.body.length > 0),

    'contenido JSON': (res) =>
      String(res.headers['Content-Type'] || '')
        .toLowerCase()
        .includes('application/json'),
  });
}
