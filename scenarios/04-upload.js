import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import exec from 'k6/execution';
import {
  profileOptions,
  selectedProfile,
} from '../lib/profiles.js';
import { authenticatedSession } from '../lib/session.js';

/*
 * Escenario 04: carga y análisis de archivos.
 *
 * Modo analyze (seguro y predeterminado):
 *   autenticación -> cuota -> multipart upload -> polling ->
 *   esquema detectado -> geo-preview -> DELETE del job creado.
 *
 * Modo full (solo con autorización explícita):
 *   añade importación a GeoNode, valida la publicación WMS/WFS en GeoServer
 *   y puede finalizar metadatos. Este modo crea un dataset persistente y por
 *   eso no elimina el job automáticamente. Por seguridad, únicamente admite
 *   TEST_PROFILE=functional.
 */

export const options = profileOptions('upload', 5000);

const FILE_PATH =
  __ENV.UPLOAD_FILE || '../data/upload-pilot.csv';

const FILE_BYTES = open(FILE_PATH, 'b');

function envBoolean(name, fallback) {
  const value = __ENV[name];

  if (value === undefined || value === '') {
    return fallback;
  }

  return String(value).toLowerCase() === 'true';
}

function configuration() {
  if (!__ENV.BASE_URL) {
    fail('La variable BASE_URL es obligatoria');
  }

  const mode = String(
    __ENV.UPLOAD_MODE || 'analyze'
  ).toLowerCase();

  if (!['analyze', 'full'].includes(mode)) {
    fail('UPLOAD_MODE debe ser analyze o full');
  }

  if (
    mode === 'full' &&
    selectedProfile() !== 'functional'
  ) {
    fail(
      'UPLOAD_MODE=full solo permite TEST_PROFILE=functional'
    );
  }

  return {
    baseUrl: String(__ENV.BASE_URL).replace(/\/+$/, ''),
    adminBase: String(__ENV.ADMIN_BASE || '/admin'),
    apiBase: String(__ENV.API_BASE || '/api/v2'),
    mode,
    useGnoxy: envBoolean('UPLOAD_USE_GNOXY', true),
    filename: String(
      __ENV.UPLOAD_FILENAME ||
        'geosuite_k6_upload_pilot.csv'
    ),
    pollInterval: Number(
      __ENV.UPLOAD_POLL_INTERVAL_SECONDS || 1
    ),
    pollTimeout: Number(
      __ENV.UPLOAD_POLL_TIMEOUT_SECONDS || 60
    ),
    geoPreview: envBoolean(
      'UPLOAD_GEO_PREVIEW',
      true
    ),
    cleanupJob: envBoolean(
      'UPLOAD_CLEANUP_JOB',
      true
    ),
    finalize: envBoolean(
      'UPLOAD_FINALIZE',
      false
    ),
    verifyGeoserver: envBoolean(
      'UPLOAD_VERIFY_GEOSERVER',
      true
    ),
    geoserverTimeout: Number(
      __ENV.UPLOAD_GEOSERVER_TIMEOUT_SECONDS || 90
    ),
    geoserverBase: String(
      __ENV.GEOSERVER_BASE || '/gs'
    ).replace(/\/+$/, ''),
  };
}

/*
 * En analyze cada iteración usa un nombre distinto para evitar colisiones
 * cuando el escenario se ejecute con varios VUs. En full se conserva el
 * nombre solicitado porque esa modalidad solo admite una ejecución
 * controlada y crea un dataset persistente.
 */
function filenameForIteration(config) {
  if (config.mode === 'full') {
    return config.filename;
  }

  const match = config.filename.match(
    /^(.*?)(\.[^.]+)?$/
  );
  const stem = match?.[1] || config.filename;
  const extension = match?.[2] || '';

  return (
    `${stem}-vu${exec.vu.idInTest}` +
    `-iter${exec.scenario.iterationInTest}` +
    extension
  );
}

function parseJson(response) {
  try {
    return response.json();
  } catch (_) {
    return null;
  }
}

function apiUrl(config, path) {
  const direct =
    `${config.baseUrl}${config.apiBase}` +
    `/data-importer/jobs${path}`;

  if (!config.useGnoxy) {
    return direct;
  }

  const relative = direct.slice(config.baseUrl.length);

  return (
    `${config.baseUrl}${config.adminBase}` +
    `/api/gnoxy${relative}`
  );
}

function appendQuery(baseUrl, parameters) {
  const separator = baseUrl.includes('?')
    ? (
        baseUrl.endsWith('?') || baseUrl.endsWith('&')
          ? ''
          : '&'
      )
    : '?';

  const query = Object.entries(parameters)
    .filter(
      ([, value]) =>
        value !== undefined && value !== null
    )
    .map(
      ([name, value]) =>
        `${encodeURIComponent(name)}=` +
        `${encodeURIComponent(String(value))}`
    )
    .join('&');

  return `${baseUrl}${separator}${query}`;
}

/* Misma ruta de proxy utilizada por useGnoxyUrl en el frontend admin. */
function gnoxyUrl(config, targetUrl) {
  if (targetUrl.startsWith(config.baseUrl)) {
    const relative = targetUrl.slice(config.baseUrl.length);
    const path = relative.startsWith('/')
      ? relative
      : `/${relative}`;

    return (
      `${config.baseUrl}${config.adminBase}` +
      `/api/gnoxy${path}`
    );
  }

  return (
    `${config.baseUrl}${config.adminBase}` +
    '/api/gnoxy/proxy/?url=' +
    encodeURIComponent(targetUrl)
  );
}

function bboxFromDataset(dataset) {
  const coords = dataset?.extent?.coords;

  if (
    Array.isArray(coords) &&
    coords.length >= 4 &&
    coords.slice(0, 4).every(
      (value) => Number.isFinite(Number(value))
    )
  ) {
    return coords.slice(0, 4).map(Number);
  }

  // Cobertura pequeña que contiene los tres puntos del CSV sintético.
  return [-99.16, 19.41, -99.11, 19.46];
}

function datasetDetailUrl(config, datasetId) {
  return (
    `${config.baseUrl}${config.apiBase}` +
    `/datasets/${encodeURIComponent(datasetId)}/`
  );
}

function getDatasetDetail(config, auth, datasetId) {
  const response = http.get(
    datasetDetailUrl(config, datasetId),
    requestOptions(auth, 'dataset_detail')
  );

  const data = parseJson(response);
  const dataset = data?.dataset || data;

  const valid = check(response, {
    'carga: dataset HTTP 200':
      (res) => res.status === 200,

    'carga: dataset JSON válido':
      () => data !== null,

    'carga: dataset contiene alternate':
      () => String(dataset?.alternate || '').length > 0,
  });

  if (!valid) {
    fail('GeoNode no devolvió el dataset importado');
  }

  return dataset;
}

function wmsCandidates(config, dataset) {
  return [...new Set([
    dataset?.ows_url,
    dataset?.dataset_ows_url,
    `${config.baseUrl}${config.geoserverBase}/wms`,
    `${config.baseUrl}/geoserver/ows`,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

function verifyWms(config, auth, dataset) {
  const alternate = String(dataset.alternate || '');
  const bbox = bboxFromDataset(dataset);
  const deadline =
    Date.now() + config.geoserverTimeout * 1000;

  while (Date.now() < deadline) {
    for (const service of wmsCandidates(config, dataset)) {
      const directUrl = appendQuery(service, {
        SERVICE: 'WMS',
        VERSION: '1.1.1',
        REQUEST: 'GetMap',
        LAYERS: alternate,
        STYLES: '',
        SRS: 'EPSG:4326',
        BBOX: bbox.join(','),
        WIDTH: 512,
        HEIGHT: 512,
        FORMAT: 'image/png',
        TRANSPARENT: 'true',
      });

      const params = requestOptions(
        auth,
        'verify_geoserver_wms',
        { accept: 'image/png' }
      );
      params.responseType = 'binary';
      params.responseCallback = http.expectedStatuses(
        200,
        400,
        401,
        403,
        404
      );

      const response = http.get(
        gnoxyUrl(config, directUrl),
        params
      );

      const contentType = String(
        response.headers['Content-Type'] || ''
      ).toLowerCase();

      const valid =
        response.status === 200 &&
        contentType.includes('image/') &&
        Number(response.body?.byteLength || 0) > 0;

      if (valid) {
        check(response, {
          'carga: GeoServer WMS HTTP 200':
            (res) => res.status === 200,

          'carga: GeoServer WMS devuelve imagen':
            () => contentType.includes('image/'),

          'carga: imagen importada no vacía':
            (res) =>
              Number(res.body?.byteLength || 0) > 0,
        });

        console.info(
          `[carga] WMS verificado: ` +
          `layer=${alternate}, service=${service}`
        );

        return service;
      }
    }

    sleep(config.pollInterval);
  }

  fail(
    `GeoServer no sirvió la capa ${alternate} ` +
    `en ${config.geoserverTimeout}s`
  );
}

function verifyWfs(config, auth, dataset) {
  const alternate = String(dataset.alternate || '');
  const candidates = [...new Set([
    dataset?.ows_url,
    `${config.baseUrl}${config.geoserverBase}/ows`,
    `${config.baseUrl}/geoserver/ows`,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean))];

  for (const service of candidates) {
    const directUrl = appendQuery(service, {
      service: 'WFS',
      version: '1.1.0',
      request: 'GetFeature',
      typeName: alternate,
      resultType: 'hits',
    });

    const params = requestOptions(
      auth,
      'verify_geoserver_wfs',
      { accept: 'application/xml,text/xml' }
    );
    params.responseCallback = http.expectedStatuses(
      200,
      400,
      401,
      403,
      404
    );

    const response = http.get(
      gnoxyUrl(config, directUrl),
      params
    );
    const body = String(response.body || '');
    const match = body.match(
      /(?:numberOfFeatures|numberMatched)=["'](\d+)["']/i
    );
    const count = match ? Number(match[1]) : -1;

    if (response.status === 200 && count >= 3) {
      check(response, {
        'carga: GeoServer WFS HTTP 200':
          (res) => res.status === 200,

        'carga: WFS reconoce la capa importada':
          () => count >= 0,

        'carga: WFS contiene los tres puntos':
          () => count >= 3,
      });

      console.info(
        `[carga] WFS verificado: ` +
        `layer=${alternate}, features=${count}`
      );

      return;
    }
  }

  fail(
    `GeoServer WFS no reconoció tres elementos de ${alternate}`
  );
}

function requestOptions(auth, operation, extra = {}) {
  const headers = {
    Accept: extra.accept || 'application/json',
    ...(extra.headers || {}),
  };

  if (auth?.accessToken) {
    headers.Authorization =
      `Bearer ${auth.accessToken}`;
  }

  if (auth?.cookieHeader) {
    headers.Cookie = auth.cookieHeader;
  }

  return {
    redirects: 0,
    headers,
    tags: {
      scenario: 'upload',
      operation,
    },
  };
}

function pollJob(config, auth, jobId, terminalStates) {
  const deadline = Date.now() + config.pollTimeout * 1000;
  let data = null;
  let response = null;

  while (Date.now() < deadline) {
    response = http.get(
      apiUrl(config, `/${jobId}/`),
      requestOptions(auth, 'poll_job')
    );

    data = parseJson(response);

    if (
      response.status === 200 &&
      terminalStates.includes(data?.status)
    ) {
      return { response, data };
    }

    sleep(config.pollInterval);
  }

  return { response, data };
}

function cleanupJob(config, auth, jobId) {
  const response = http.del(
    apiUrl(config, `/${jobId}/`),
    null,
    requestOptions(auth, 'delete_job')
  );

  check(response, {
    'carga: limpieza del job HTTP 204':
      (res) => res.status === 204,
  });
}

export default function () {
  const config = configuration();
  const filename = filenameForIteration(config);
  const auth = authenticatedSession();
  let jobId = null;
  let imported = false;

  try {
    // 1. La cuota evita iniciar una carga que el backend rechazará.
    const quotaResponse = http.get(
      apiUrl(config, '/quota/'),
      requestOptions(auth, 'get_quota')
    );

    const quota = parseJson(quotaResponse);

    const quotaValid = check(quotaResponse, {
      'carga: cuota HTTP 200':
        (res) => res.status === 200,

      'carga: cuota JSON válida':
        () => quota !== null,

      'carga: cuota permite subir':
        () => quota?.can_upload === true,

      'carga: cuota informa espacio restante':
        () => Number(quota?.remaining) > 0,
    });

    if (!quotaValid) {
      fail('La cuota del usuario no permite cargar');
    }

    sleep(1);

    // 2. k6 genera multipart/form-data y su boundary automáticamente.
    const uploadResponse = http.post(
      apiUrl(config, '/upload/'),
      {
        file: http.file(
          FILE_BYTES,
          filename,
          'text/csv'
        ),
      },
      requestOptions(auth, 'upload_file')
    );

    const uploadedJob = parseJson(uploadResponse);
    jobId = uploadedJob?.id || null;

    const uploadValid = check(uploadResponse, {
      'carga: upload HTTP 201':
        (res) => res.status === 201,

      'carga: upload JSON válido':
        () => uploadedJob !== null,

      'carga: job creado':
        () => Number(jobId) > 0,

      'carga: nombre de archivo registrado':
        () =>
          uploadedJob?.original_filename ===
          filename,
    });

    if (!uploadValid) {
      fail('No fue posible crear el job de carga');
    }

    console.info(
      `[carga] job creado: id=${jobId}, ` +
      `status=${uploadedJob.status}, ` +
      `file=${filename}`
    );

    // 3. Celery analiza columnas y cambia pending/analyzing -> ready.
    const analyzed = pollJob(
      config,
      auth,
      jobId,
      ['ready', 'error']
    );

    const analysisValid = check(analyzed.response, {
      'carga: análisis HTTP 200':
        (res) => res?.status === 200,

      'carga: análisis termina en ready':
        () => analyzed.data?.status === 'ready',

      'carga: esquema detectado':
        () =>
          Array.isArray(analyzed.data?.column_schema) &&
          analyzed.data.column_schema.length >= 4,

      'carga: estrategia geográfica detectada':
        () =>
          String(analyzed.data?.geo_strategy || '')
            .length > 0,
    });

    if (!analysisValid) {
      const message =
        analyzed.data?.error_message ||
        'timeout o estado inesperado';

      fail(`El análisis del archivo falló: ${message}`);
    }

    console.info(
      `[carga] análisis listo: id=${jobId}, ` +
      `strategy=${analyzed.data.geo_strategy}, ` +
      `columns=${analyzed.data.column_schema.length}`
    );

    // 4. Reproduce la previsualización del wizard para latitud/longitud.
    if (config.geoPreview) {
      const previewPayload = JSON.stringify({
        geo_strategy: analyzed.data.geo_strategy,
        geo_field_lat:
          analyzed.data.geo_field_lat || '',
        geo_field_lon:
          analyzed.data.geo_field_lon || '',
        geo_field_join:
          analyzed.data.geo_field_join || '',
      });

      const previewResponse = http.post(
        apiUrl(config, `/${jobId}/geo-preview/`),
        previewPayload,
        requestOptions(
          auth,
          'geo_preview',
          {
            headers: {
              'Content-Type': 'application/json',
            },
          }
        )
      );

      const preview = parseJson(previewResponse);

      const previewValid = check(previewResponse, {
        'carga: preview HTTP 200':
          (res) => res.status === 200,

        'carga: preview JSON válida':
          () => preview !== null,

        'carga: preview correcta':
          () => preview?.ok === true,
      });

      if (!previewValid) {
        fail(
          `La previsualización falló: ` +
          `${preview?.error || 'respuesta inválida'}`
        );
      }
    }

    if (config.mode === 'full') {
      // Este bloque crea un dataset persistente. Nunca es el modo por defecto.
      const importResponse = http.post(
        apiUrl(config, `/${jobId}/import/`),
        null,
        requestOptions(auth, 'import_to_geonode')
      );

      const importStarted = check(importResponse, {
        'carga: importación HTTP 200':
          (res) => res.status === 200,
      });

      if (!importStarted) {
        fail('No fue posible iniciar la importación');
      }

      const importedJob = pollJob(
        config,
        auth,
        jobId,
        ['done', 'error']
      );

      const importValid = check(importedJob.response, {
        'carga: importación termina en done':
          () => importedJob.data?.status === 'done',

        'carga: dataset de GeoNode creado':
          () =>
            Number(importedJob.data?.geonode_dataset_id) > 0,
      });

      if (!importValid) {
        fail(
          `La importación falló: ` +
          `${importedJob.data?.error_message || 'estado inesperado'}`
        );
      }

      imported = true;

      const datasetId =
        importedJob.data.geonode_dataset_id;
      const dataset = getDatasetDetail(
        config,
        auth,
        datasetId
      );

      console.info(
        `[carga] dataset creado: id=${datasetId}, ` +
        `alternate=${dataset.alternate}`
      );

      if (config.verifyGeoserver) {
        verifyWms(config, auth, dataset);
        verifyWfs(config, auth, dataset);
      }

      if (config.finalize) {
        const finalizeResponse = http.post(
          apiUrl(config, `/${jobId}/finalize-layer/`),
          JSON.stringify({
            name: filename.replace(/\.csv$/i, ''),
            layer_abstract:
              'Recurso sintético de validación k6',
            layer_keywords: 'k6,rendimiento,piloto',
            style_specs: [],
          }),
          requestOptions(
            auth,
            'finalize_layer',
            {
              headers: {
                'Content-Type': 'application/json',
              },
            }
          )
        );

        const finalized = parseJson(finalizeResponse);

        check(finalizeResponse, {
          'carga: finalización HTTP 200':
            (res) => res.status === 200,

          'carga: finalización devuelve dataset':
            () => Number(finalized?.dataset_id) > 0,
        });
      }

    }
  } finally {
    /*
     * Solo se elimina automáticamente el job del modo analyze. En full,
     * el dataset persiste y se conserva el job para trazabilidad.
     */
    if (
      jobId &&
      config.cleanupJob &&
      !imported &&
      config.mode === 'analyze'
    ) {
      cleanupJob(config, auth, jobId);
    }
  }
}
