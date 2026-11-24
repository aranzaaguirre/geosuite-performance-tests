import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { profileOptions } from '../lib/profiles.js';
import { authenticatedSession } from '../lib/session.js';

/*
 * Escenario 03: visualización de mapas y capas.
 *
 * Alcance:
 * - Descubre automáticamente un mapa visible con capas.
 * - Usa /app/mapas/{id} para usuarios anónimos.
 * - Usa /admin/mapas/{id} para usuarios autenticados.
 * - Consulta el detalle del mapa y sus capas.
 * - Para vectores locales WMTS intenta la ruta real:
 *     GetCapabilities -> GetStyles -> GetTile MVT.
 * - Si WMTS/MVT no está disponible, utiliza WMS GetMap,
 *   igual que el comportamiento adaptativo del frontend.
 * - Opcionalmente simula una consulta WFS y un clic
 *   GetFeatureInfo.
 *
 * Este script no crea, modifica ni elimina mapas o capas.
 */

export const options = profileOptions('maps', 3000);

const MVT_FORMAT =
  'application/vnd.mapbox-vector-tile';

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

  if (!__ENV.GEOSERVER_BASE) {
    fail(
      'La variable GEOSERVER_BASE es obligatoria'
    );
  }

  const authenticated = envBoolean(
    'MAP_AUTHENTICATED',
    false
  );

  return {
    baseUrl: String(
      __ENV.BASE_URL
    ).replace(/\/+$/, ''),

    geoserverBase: String(
      __ENV.GEOSERVER_BASE
    ).replace(/\/+$/, ''),

    viewerBase: authenticated
      ? String(__ENV.ADMIN_BASE || '/admin')
      : String(__ENV.APP_BASE || '/app'),

    authenticated,

    mapId: String(
      __ENV.MAP_ID || ''
    ).trim(),

    pageSize: Number(
      __ENV.MAP_DISCOVERY_PAGE_SIZE || 100
    ),

    maxLayers: Number(
      __ENV.MAP_MAX_LAYERS || 3
    ),

    tileZoom: Number(
      __ENV.MAP_TILE_ZOOM || 10
    ),

    width: Number(
      __ENV.MAP_WIDTH || 800
    ),

    height: Number(
      __ENV.MAP_HEIGHT || 600
    ),

    format: String(
      __ENV.MAP_FORMAT || 'image/png'
    ),

    failIfMissing: envBoolean(
      'MAP_FAIL_IF_MISSING',
      true
    ),

    validateFallback: envBoolean(
      'MAP_VALIDATE_FALLBACK',
      true
    ),

    validateInteraction: envBoolean(
      'MAP_VALIDATE_INTERACTION',
      true
    ),
  };
}

function parseJson(response) {
  try {
    return response.json();
  } catch (_) {
    return null;
  }
}

function requestOptions(
  auth,
  operation,
  extra = {}
) {
  const headers = {
    Accept: extra.accept || '*/*',
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
    responseType:
      extra.responseType || 'text',
    headers,
    tags: {
      scenario: 'maps',
      operation,
      ...(extra.tags || {}),
    },
  };
}

function appendQuery(baseUrl, parameters) {
  const separator = baseUrl.includes('?')
    ? (
        baseUrl.endsWith('?') ||
        baseUrl.endsWith('&')
          ? ''
          : '&'
      )
    : '?';

  const query = Object.entries(parameters)
    .filter(
      ([, value]) =>
        value !== undefined &&
        value !== null
    )
    .map(
      ([name, value]) =>
        `${encodeURIComponent(name)}=` +
        `${encodeURIComponent(String(value))}`
    )
    .join('&');

  return `${baseUrl}${separator}${query}`;
}

function isRemote(layer) {
  return (
    String(
      layer.dataset_sourcetype || ''
    ).toUpperCase() === 'REMOTE' ||
    String(
      layer.dataset_subtype || ''
    ).toLowerCase() === 'remote'
  );
}

function isVector(layer) {
  return String(
    layer.dataset_subtype || ''
  ).toLowerCase() === 'vector';
}

function isWmts(layer) {
  return String(
    layer.layer_type || ''
  ).toLowerCase() === 'wmts';
}

function layerName(layer) {
  return String(
    layer.wms_layer_name ||
    layer.name ||
    ''
  );
}

function wmtsStyle(layer) {
  const style = String(layer.style || '');
  const name = layerName(layer);

  if (
    !style ||
    style.includes(':') ||
    !name.includes(':')
  ) {
    return style;
  }

  /*
   * GeoWebCache requiere normalmente el workspace:
   * ejemplo_poligono -> geonode:ejemplo_poligono.
   */
  return `${name.split(':')[0]}:${style}`;
}

function selectMap(maps, configuredId) {
  if (configuredId) {
    return maps.find(
      (map) =>
        String(map.id) === configuredId
    );
  }

  return maps.find(
    (map) =>
      Number(map.layers_count || 0) > 0
  );
}

function flattenCoordinates(value, result = []) {
  if (!Array.isArray(value)) {
    return result;
  }

  if (
    value.length >= 2 &&
    Number.isFinite(Number(value[0])) &&
    Number.isFinite(Number(value[1]))
  ) {
    result.push([
      Number(value[0]),
      Number(value[1]),
    ]);

    return result;
  }

  for (const item of value) {
    flattenCoordinates(item, result);
  }

  return result;
}

function bboxFromDataset(dataset) {
  const coords = dataset?.extent?.coords;

  if (
    Array.isArray(coords) &&
    coords.length >= 4 &&
    coords.slice(0, 4).every(
      (value) =>
        Number.isFinite(Number(value))
    )
  ) {
    return coords.slice(0, 4).map(Number);
  }

  const points = flattenCoordinates(
    dataset?.ll_bbox_polygon?.coordinates
  );

  if (points.length > 0) {
    const xs = points.map(
      (point) => point[0]
    );

    const ys = points.map(
      (point) => point[1]
    );

    return [
      Math.min(...xs),
      Math.min(...ys),
      Math.max(...xs),
      Math.max(...ys),
    ];
  }

  /*
   * Solo se utiliza si el dataset no informa extensión.
   * Evita impedir completamente la validación WMS.
   */
  return [-180, -85, 180, 85];
}

function tileForBbox(bbox, zoom) {
  const longitude =
    (bbox[0] + bbox[2]) / 2;

  const latitude =
    (bbox[1] + bbox[3]) / 2;

  const limitedLatitude = Math.max(
    -85.05112878,
    Math.min(85.05112878, latitude)
  );

  const count = 2 ** zoom;

  const x = Math.floor(
    ((longitude + 180) / 360) * count
  );

  const radians =
    limitedLatitude * Math.PI / 180;

  const y = Math.floor(
    (
      1 -
      Math.log(
        Math.tan(radians) +
        1 / Math.cos(radians)
      ) / Math.PI
    ) / 2 * count
  );

  return {
    x: Math.max(
      0,
      Math.min(count - 1, x)
    ),

    y: Math.max(
      0,
      Math.min(count - 1, y)
    ),
  };
}

/*
 * Reproduce el comportamiento de useGnoxyUrl:
 *
 * - URL del mismo GeoSuite:
 *   /admin|app/api/gnoxy/ruta
 *
 * - URL externa:
 *   /admin|app/api/gnoxy/proxy/?url=...
 */
function gnoxyUrl(config, targetUrl) {
  if (targetUrl.startsWith(config.baseUrl)) {
    const relative =
      targetUrl.slice(config.baseUrl.length);

    const path = relative.startsWith('/')
      ? relative
      : `/${relative}`;

    return (
      `${config.baseUrl}` +
      `${config.viewerBase}` +
      `/api/gnoxy${path}`
    );
  }

  return (
    `${config.baseUrl}` +
    `${config.viewerBase}` +
    '/api/gnoxy/proxy/?url=' +
    encodeURIComponent(targetUrl)
  );
}

function requestUrlForLayer(
  config,
  layer,
  targetUrl
) {
  /*
   * Las capas locales publicadas se consultan
   * directamente. Las privadas y remotas pasan por
   * gnoxy para mantener sesión y evitar problemas CORS.
   */
  const direct =
    !isRemote(layer) &&
    layer.dataset_is_published === true;

  return direct
    ? targetUrl
    : gnoxyUrl(config, targetUrl);
}

function datasetDetail(
  config,
  auth,
  datasetId
) {
  if (!datasetId) {
    return null;
  }

  const response = http.get(
    `${config.baseUrl}/api/v2/datasets/` +
      `${encodeURIComponent(datasetId)}/`,
    requestOptions(
      auth,
      'dataset_detail',
      {
        accept: 'application/json',
        tags: {
          dataset_id: String(datasetId),
        },
      }
    )
  );

  const data = parseJson(response);

  const valid = check(response, {
    'mapas: dataset HTTP 200':
      (res) => res.status === 200,

    'mapas: dataset JSON válido':
      () => data !== null,
  });

  if (!valid && config.failIfMissing) {
    fail(
      `No fue posible consultar el dataset ` +
      `${datasetId}`
    );
  }

  return data?.dataset || data;
}

function validateWmts(
  config,
  auth,
  layer,
  bbox
) {
  const name = layerName(layer);

  const endpoint =
    `${config.baseUrl}` +
    `${config.geoserverBase}` +
    '/gwc/service/wmts';

  const capabilitiesUrl = appendQuery(
    endpoint,
    {
      SERVICE: 'WMTS',
      REQUEST: 'GetCapabilities',
      VERSION: '1.0.0',
    }
  );

  const capabilitiesResponse = http.get(
    capabilitiesUrl,
    requestOptions(
      auth,
      'wmts_get_capabilities',
      {
        accept: 'application/xml,text/xml',
        tags: {
          layer: name,
        },
      }
    )
  );

  const body = String(
    capabilitiesResponse.body || ''
  );

  const baseValid = check(
    capabilitiesResponse,
    {
      'mapas: WMTS capabilities HTTP 200':
        (res) => res.status === 200,

      'mapas: WMTS capabilities XML':
        () => body.trim().startsWith('<'),
    }
  );

  if (!baseValid) {
    console.warn(
      `[mapas] WMTS GetCapabilities no está ` +
      `disponible para ${name}; se usará WMS`
    );

    return false;
  }

  const layerAdvertised =
    body.includes(name);

  const mvtAdvertised =
    body.includes(MVT_FORMAT);

  /*
   * La ausencia de la capa o de MVT no se marca como
   * check fallido. El frontend también contempla esta
   * condición y cambia a WMS.
   */
  if (!layerAdvertised || !mvtAdvertised) {
    console.warn(
      `[mapas] WMTS/MVT no anunciado para ${name}; ` +
      `layer=${layerAdvertised}, ` +
      `mvt=${mvtAdvertised}. Se usará WMS.`
    );

    return false;
  }

  const stylesUrl = appendQuery(
    `${config.baseUrl}` +
      `${config.geoserverBase}/wms`,
    {
      SERVICE: 'WMS',
      REQUEST: 'GetStyles',
      VERSION: '1.1.1',
      LAYERS: name,
    }
  );

  const stylesResponse = http.get(
    stylesUrl,
    requestOptions(
      auth,
      'wms_get_styles',
      {
        accept: 'application/xml,text/xml',
        tags: {
          layer: name,
        },
      }
    )
  );

  const stylesValid = check(stylesResponse, {
    'mapas: GetStyles HTTP 200':
      (res) => res.status === 200,

    'mapas: GetStyles devuelve XML':
      (res) =>
        String(res.body || '')
          .trim()
          .startsWith('<'),
  });

  if (!stylesValid) {
    console.warn(
      `[mapas] GetStyles falló para ${name}; ` +
      'se usará WMS'
    );

    return false;
  }

  const tile = tileForBbox(
    bbox,
    config.tileZoom
  );

  const tileUrl = appendQuery(
    endpoint,
    {
      SERVICE: 'WMTS',
      REQUEST: 'GetTile',
      VERSION: '1.0.0',
      LAYER: name,
      STYLE: wmtsStyle(layer),
      FORMAT: MVT_FORMAT,
      TILEMATRIXSET: 'EPSG:3857',
      TILEMATRIX:
        `EPSG:3857:${config.tileZoom}`,
      TILEROW: tile.y,
      TILECOL: tile.x,
    }
  );

  const tileResponse = http.get(
    tileUrl,
    requestOptions(
      auth,
      'wmts_get_mvt_tile',
      {
        accept: MVT_FORMAT,
        responseType: 'binary',
        tags: {
          layer: name,
          zoom: String(config.tileZoom),
        },
      }
    )
  );

  const contentType = String(
    tileResponse.headers['Content-Type'] || ''
  ).toLowerCase();

  const tileValid = check(tileResponse, {
    'mapas: tesela MVT HTTP válida':
      (res) =>
        res.status === 200 ||
        res.status === 204,

    'mapas: tesela devuelve MVT':
      (res) =>
        res.status === 204 ||
        contentType.includes(MVT_FORMAT) ||
        contentType.includes(
          'application/x-protobuf'
        ),
  });

  if (!tileValid) {
    console.warn(
      `[mapas] la tesela MVT falló para ${name}; ` +
      'se usará WMS'
    );

    return false;
  }

  return true;
}

/*
 * Devuelve fuentes WMS candidatas sin fijar un recurso ni una ruta.
 * GeoNode puede informar ows_url, mientras que capas remotas exponen
 * wms_url. Los alias globales quedan como respaldo entre ambientes.
 */
function wmsServices(config, layer, dataset) {
  const candidates = isRemote(layer)
    ? [
        layer.wms_url,
        dataset?.dataset_ows_url,
        dataset?.ows_url,
      ]
    : [
        dataset?.ows_url,
        dataset?.dataset_ows_url,
        `${config.baseUrl}${config.geoserverBase}/wms`,
        `${config.baseUrl}/geoserver/ows`,
      ];

  return [...new Set(
    candidates
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

/*
 * Descubre una fuente capaz de dibujar la capa. Durante esta fase un
 * LayerNotDefined o un 404 se documentan y se continúa con la siguiente
 * fuente/capa; solo la respuesta válida genera checks de aceptación.
 */
function discoverWmsGetMap(
  config,
  auth,
  layer,
  dataset,
  bbox,
  reason
) {
  const name = layerName(layer);
  const services = wmsServices(
    config,
    layer,
    dataset
  );

  for (const service of services) {
    const directUrl = appendQuery(
      service,
      {
        SERVICE: 'WMS',
        VERSION: '1.1.1',
        REQUEST: 'GetMap',
        LAYERS: name,
        STYLES: layer.style || '',
        SRS: 'EPSG:4326',
        BBOX: bbox.join(','),
        WIDTH: config.width,
        HEIGHT: config.height,
        FORMAT: config.format,
        TRANSPARENT: 'true',
      }
    );

    const finalUrl = requestUrlForLayer(
      config,
      layer,
      directUrl
    );

    const params = requestOptions(
      auth,
      'wms_get_map_discovery',
      {
        accept: config.format,
        responseType: 'binary',
        tags: {
          layer: name,
          reason,
        },
      }
    );

    // Un 404 es un resultado de descubrimiento esperado, no un fallo HTTP
    // de la prueba definitiva.
    params.responseCallback = http.expectedStatuses(
      200,
      400,
      401,
      403,
      404
    );

    const response = http.get(finalUrl, params);
    const contentType = String(
      response.headers['Content-Type'] || ''
    ).toLowerCase();

    const valid =
      response.status === 200 &&
      contentType.includes('image/') &&
      Number(response.body?.byteLength || 0) > 0;

    if (!valid) {
      console.warn(
        `[mapas] fuente WMS descartada: ` +
        `map=${layer.map}, layer=${name}, ` +
        `service=${service}, status=${response.status}, ` +
        `content_type=${contentType || 'n/a'}`
      );
      continue;
    }

    check(response, {
      'mapas: WMS GetMap HTTP 200':
        (res) => res.status === 200,

      'mapas: WMS GetMap devuelve imagen':
        () => contentType.includes('image/'),

      'mapas: imagen WMS no vacía':
        (res) =>
          Number(res.body?.byteLength || 0) > 0,
    });

    return { service, response };
  }

  return null;
}

function validateWfsHits(
  config,
  auth,
  layer,
  service
) {
  /*
   * WFS se valida solamente para vectores locales.
   * Un WMS remoto no necesariamente ofrece WFS.
   */
  if (!isVector(layer) || isRemote(layer)) {
    return;
  }

  const name = layerName(layer);

  const directUrl = appendQuery(
    service,
    {
      service: 'WFS',
      version: '1.1.0',
      request: 'GetFeature',
      typeName: name,
      resultType: 'hits',
    }
  );

  const finalUrl = requestUrlForLayer(
    config,
    layer,
    directUrl
  );

  const response = http.get(
    finalUrl,
    requestOptions(
      auth,
      'wfs_get_feature_hits',
      {
        accept: 'application/xml,text/xml',
        tags: {
          layer: name,
        },
      }
    )
  );

  const body = String(response.body || '');

  const valid = check(response, {
    'mapas: WFS hits HTTP 200':
      (res) => res.status === 200,

    'mapas: WFS hits devuelve XML':
      () => body.trim().startsWith('<'),

    'mapas: WFS devuelve conteo':
      () =>
        /numberOfFeatures|numberMatched/i.test(
          body
        ),
  });

  if (!valid && config.failIfMissing) {
    fail(`WFS falló para ${name}`);
  }
}

function validateFeatureInfo(
  config,
  auth,
  layer,
  bbox,
  service
) {
  const name = layerName(layer);

  if (!service) {
    return;
  }

  const directUrl = appendQuery(
    service,
    {
      SERVICE: 'WMS',
      VERSION: '1.1.1',
      REQUEST: 'GetFeatureInfo',
      LAYERS: name,
      QUERY_LAYERS: name,
      STYLES: layer.style || '',
      SRS: 'EPSG:4326',
      BBOX: bbox.join(','),
      WIDTH: config.width,
      HEIGHT: config.height,
      X: Math.floor(config.width / 2),
      Y: Math.floor(config.height / 2),
      FEATURE_COUNT: 1,
      INFO_FORMAT: 'application/json',
    }
  );

  const finalUrl = requestUrlForLayer(
    config,
    layer,
    directUrl
  );

  const response = http.get(
    finalUrl,
    requestOptions(
      auth,
      'wms_get_feature_info',
      {
        accept: 'application/json',
        tags: {
          layer: name,
        },
      }
    )
  );

  const data = parseJson(response);

  const valid = check(response, {
    'mapas: GetFeatureInfo HTTP 200':
      (res) => res.status === 200,

    'mapas: GetFeatureInfo JSON válido':
      () => data !== null,

    'mapas: GetFeatureInfo contiene features':
      () => Array.isArray(data?.features),
  });

  if (!valid && config.failIfMissing) {
    fail(
      `GetFeatureInfo falló para ${name}`
    );
  }
}

export default function () {
  const config = configuration();

  /*
   * En modo autenticado se reproduce el flujo completo:
   * NextAuth -> Keycloak -> sesión -> Django/GeoNode.
   */
  const auth = config.authenticated
    ? authenticatedSession()
    : null;

  const listResponse = http.get(
    `${config.baseUrl}/api/v2/sigic-maps/` +
      `?page=1&page_size=${config.pageSize}`,
    requestOptions(
      auth,
      'list_maps',
      {
        accept: 'application/json',
        tags: {
          access:
            config.authenticated
              ? 'authenticated'
              : 'public',
        },
      }
    )
  );

  const listData = parseJson(listResponse);

  const maps = Array.isArray(
    listData?.results
  )
    ? listData.results
    : [];

  const listValid = check(listResponse, {
    'mapas: listado HTTP 200':
      (res) => res.status === 200,

    'mapas: listado JSON válido':
      () => listData !== null,

    'mapas: listado contiene results':
      () => Array.isArray(
        listData?.results
      ),

    'mapas: existe un mapa':
      () => maps.length > 0,
  });

  if (!listValid) {
    fail('No fue posible consultar los mapas');
  }

  const candidateMaps = config.mapId
    ? maps.filter(
        (map) =>
          String(map.id) === config.mapId
      )
    : maps.filter(
        (map) =>
          Number(map.layers_count || 0) > 0
      );

  if (candidateMaps.length === 0) {
    const message =
      config.mapId
        ? `No existe MAP_ID=${config.mapId}`
        : 'No existe un mapa visible con capas';

    if (config.failIfMissing) {
      fail(message);
    }

    console.warn(`[mapas] ${message}`);
    return;
  }

  let selected = null;

  for (const candidateMap of candidateMaps) {
    console.info(
      `[mapas] examinando mapa: id=${candidateMap.id}, ` +
      `name=${candidateMap.name}, ` +
      `layers=${candidateMap.layers_count}`
    );

    const detailResponse = http.get(
      `${config.baseUrl}/api/v2/sigic-maps/` +
        `${encodeURIComponent(candidateMap.id)}/`,
      requestOptions(
        auth,
        'map_detail_discovery',
        {
          accept: 'application/json',
          tags: {
            map_id: String(candidateMap.id),
          },
        }
      )
    );

    const mapData = parseJson(detailResponse);
    const layers = (
      Array.isArray(mapData?.layers)
        ? mapData.layers
        : []
    )
      .filter(
        (layer) =>
          layer.visible !== false &&
          Boolean(layerName(layer))
      )
      .slice(0, config.maxLayers);

    for (const layer of layers) {
    const name = layerName(layer);

    console.info(
      `[mapas] capa: id=${layer.id}, ` +
      `name=${name}, ` +
      `type=${layer.layer_type}, ` +
      `subtype=${layer.dataset_subtype}, ` +
      `source=${layer.dataset_sourcetype}`
    );

      const dataset = datasetDetail(
      config,
      auth,
      layer.geonode_id
    );

      const bbox = bboxFromDataset(dataset);

      let wmtsLoaded = false;

    /*
     * Solo los vectores locales configurados como WMTS
     * intentan la ruta MVT.
     */
      if (
      isWmts(layer) &&
      isVector(layer) &&
      !isRemote(layer)
    ) {
        wmtsLoaded = validateWmts(
        config,
        auth,
        layer,
        bbox
      );
      }

    /*
     * WMS se utiliza cuando:
     * - la capa no usa WMTS;
     * - WMTS/MVT no está disponible;
     * - se solicitó validar explícitamente el respaldo.
     */
      const wmsResult = (
        !wmtsLoaded ||
        config.validateFallback ||
        config.validateInteraction
      )
        ? discoverWmsGetMap(
        config,
        auth,
        layer,
        dataset,
        bbox,
        wmtsLoaded
          ? 'fallback_validation'
          : 'primary_fallback'
          )
        : null;

      if (!wmtsLoaded && !wmsResult) {
        console.warn(
          `[mapas] capa descartada: map=${candidateMap.id}, ` +
          `layer=${name}; no entrega MVT ni imagen WMS`
        );
        continue;
      }

      selected = {
        map: candidateMap,
        mapData,
        detailResponse,
        layer,
        dataset,
        bbox,
        wmtsLoaded,
        wmsService: wmsResult?.service || '',
      };
      break;
    }

    if (selected) {
      break;
    }
  }

  const usableLayerFound = check(selected, {
    'mapas: existe una capa utilizable':
      (value) => Boolean(value?.layer),
  });

  if (!usableLayerFound) {
    fail(
      'Ningún mapa visible contiene una capa ' +
      'utilizable mediante WMTS/MVT o WMS'
    );
  }

  const selectedMap = selected.map;
  const selectedLayer = selected.layer;

  console.info(
    `[mapas] selección final: map=${selectedMap.id}, ` +
    `layer=${layerName(selectedLayer)}, ` +
    `transport=${selected.wmtsLoaded ? 'WMTS/MVT' : 'WMS'}`
  );

  sleep(1);

  const viewerResponse = http.get(
    `${config.baseUrl}${config.viewerBase}/mapas/` +
      `${encodeURIComponent(selectedMap.id)}`,
    requestOptions(
      auth,
      'open_map_viewer',
      {
        accept: 'text/html',
        tags: {
          map_id: String(selectedMap.id),
          access: config.authenticated
            ? 'authenticated'
            : 'public',
        },
      }
    )
  );

  check(viewerResponse, {
    'mapas: visor HTTP 200':
      (res) => res.status === 200,

    'mapas: visor devuelve HTML':
      (res) =>
        String(res.headers['Content-Type'] || '')
          .toLowerCase()
          .includes('text/html'),
  });

  check(selected.detailResponse, {
    'mapas: detalle HTTP 200':
      (res) => res.status === 200,

    'mapas: detalle JSON válido':
      () => selected.mapData !== null,

    'mapas: detalle corresponde al mapa':
      () =>
        String(selected.mapData?.id) ===
        String(selectedMap.id),
  });

  if (
    config.validateInteraction &&
    selected.wmsService
  ) {
    sleep(1);

    validateWfsHits(
      config,
      auth,
      selectedLayer,
      selected.wmsService
    );

    sleep(1);

    validateFeatureInfo(
      config,
      auth,
      selectedLayer,
      selected.bbox,
      selected.wmsService
    );
  }
}
