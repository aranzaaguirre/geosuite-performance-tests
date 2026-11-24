import http from 'k6/http';
import { check, fail } from 'k6';

/*
 * Escenario 00: comprobación mínima de disponibilidad.
 *
 * Consulta el listado público de recursos y valida estado, cuerpo y tipo de
 * contenido. Es de solo lectura y permite detectar fallos básicos de DNS,
 * Nginx o API antes de ejecutar escenarios más costosos.
 *
 * Requiere: BASE_URL y RESOURCES_API_PATH.
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

  const resourcesPath = __ENV.RESOURCES_API_PATH;

  if (!resourcesPath) {
    fail(
      'La variable RESOURCES_API_PATH es obligatoria'
    );
  }

  const response = http.get(`${baseUrl}${resourcesPath}`, {
    tags: {
      scenario: 'smoke',
      endpoint: 'resources',
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
