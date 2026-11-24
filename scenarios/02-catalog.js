import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { profileOptions } from '../lib/profiles.js';
import { authenticatedSession } from '../lib/session.js';

/*
 * Escenario 02: navegación y consulta del catálogo.
 *
 * Descubre recursos visibles, los clasifica por perfil y reproduce apertura
 * del catálogo, filtrado, búsqueda y consulta de detalle. No depende de IDs
 * fijos y puede reutilizarse entre ambientes con contenidos diferentes. Usa
 * /admin cuando CATALOG_AUTHENTICATED=true y /app en modo público. No crea ni
 * modifica recursos.
 */

export const options = profileOptions('catalog', 2000);

const SUPPORTED_PROFILES = [
  'raster',
  'vector',
  'table',
  'pdf',
  'text',
  'remote',
];

function config() {
  if (!__ENV.BASE_URL) {
    fail('La variable BASE_URL es obligatoria');
  }

  if (!__ENV.RESOURCES_API_PATH) {
    fail(
      'La variable RESOURCES_API_PATH es obligatoria'
    );
  }

  return {
    baseUrl: __ENV.BASE_URL,
    resourcesPath: __ENV.RESOURCES_API_PATH,

    viewerBase:
      String(
        __ENV.CATALOG_AUTHENTICATED || 'false'
      ).toLowerCase() === 'true'
        ? String(__ENV.ADMIN_BASE || '/admin')
        : String(__ENV.APP_BASE || '/app'),

    pageSize: Number(
      __ENV.DISCOVERY_PAGE_SIZE || 100
    ),

    authenticated:
      String(
        __ENV.CATALOG_AUTHENTICATED || 'false'
      ).toLowerCase() === 'true',

    profiles: String(
      __ENV.CATALOG_PROFILES ||
        'raster,vector,table,pdf,text,remote'
    )
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),

    failIfMissing:
      String(
        __ENV.FAIL_IF_PROFILE_MISSING || 'false'
      ).toLowerCase() === 'true',

    includeStyles:
      String(
        __ENV.INCLUDE_STYLES || 'false'
      ).toLowerCase() === 'true',
  };
}

function parseJson(response) {
  try {
    return response.json();
  } catch (_) {
    return null;
  }
}

function normalized(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function extensionOf(resource) {
  return normalized(
    resource?.extension
  ).replace(/^\./, '');
}

function searchTerm(title) {
  const withoutExtension = String(title || '')
    .replace(/\.[^.]+$/, '');

  const words = withoutExtension
    .replace(/[_\-.,()[\]{}]+/g, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3);

  return words[0] || withoutExtension.trim();
}

function geometryValue(resource) {
  const value = resource?.has_geometry;

  if (
    value === undefined ||
    value === null ||
    value === ''
  ) {
    return null;
  }

  return (
    value === true ||
    normalized(value) === 'true'
  );
}

function hasSpatialEvidence(resource) {
  if (!resource) {
    return false;
  }

  const explicit = geometryValue(resource);

  if (explicit !== null) {
    return explicit;
  }

  const extent = resource.extent?.coords;
  const polygon =
    resource.ll_bbox_polygon?.coordinates;

  return Boolean(
    resource.dataset_ows_url ||
      (
        Array.isArray(extent) &&
        extent.length >= 4
      ) ||
      (
        resource.ll_bbox_polygon?.type ===
          'Polygon' &&
        Array.isArray(polygon) &&
        polygon.length > 0
      )
  );
}

function requestOptions(auth, tags) {
  const headers = {};

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
    tags,
  };
}

function detailUrl(baseUrl, resource) {
  const type = normalized(
    resource.resource_type ||
      resource.resourceType
  );

  if (type === 'document') {
    return (
      `${baseUrl}/api/v2/documents/` +
      `${resource.pk}/`
    );
  }

  return (
    `${baseUrl}/api/v2/datasets/` +
    `${resource.pk}/`
  );
}

function detailObject(data) {
  return (
    data?.dataset ??
    data?.document ??
    data?.resource ??
    data
  );
}

function requiresDetail(resource) {
  const type = normalized(
    resource.resource_type
  );

  const subtype = normalized(
    resource.subtype
  );

  return (
    (
      type === 'dataset' &&
      subtype === 'vector' &&
      geometryValue(resource) === null
    ) ||
    (
      type === 'document' &&
      !extensionOf(resource)
    )
  );
}

function enrichResources(
  baseUrl,
  resources,
  auth
) {
  const enriched = [];

  for (const original of resources) {
    const resource = { ...original };

    if (!requiresDetail(resource)) {
      enriched.push(resource);
      continue;
    }

    const response = http.get(
      detailUrl(baseUrl, resource),
      requestOptions(auth, {
        scenario: 'catalog',
        operation: 'resolve_metadata',
        profile: 'discovery',
        resource_id: String(resource.pk),
      })
    );

    const data = parseJson(response);
    const detail = detailObject(data);

    const valid = check(response, {
      'clasificación: detalle HTTP 200':
        (res) => res.status === 200,

      'clasificación: detalle JSON válido':
        () => data !== null,
    });

    if (!valid || !detail) {
      console.warn(
        `[catalog] no fue posible resolver ` +
          `el recurso pk=${resource.pk}`
      );

      enriched.push(resource);
      continue;
    }

    const type = normalized(
      resource.resource_type
    );

    const subtype = normalized(
      resource.subtype
    );

    if (
      type === 'dataset' &&
      subtype === 'vector'
    ) {
      resource.has_geometry =
        hasSpatialEvidence(detail);

      console.log(
        `[catalog] geometría resuelta: ` +
          `pk=${resource.pk}, ` +
          `title=${resource.title || ''}, ` +
          `has_geometry=${resource.has_geometry}`
      );
    }

    if (type === 'document') {
      resource.extension =
        detail.extension ||
        resource.extension ||
        '';

      resource.mime_type =
        detail.mime_type ||
        resource.mime_type ||
        '';

      console.log(
        `[catalog] documento resuelto: ` +
          `pk=${resource.pk}, ` +
          `title=${resource.title || ''}, ` +
          `extension=${resource.extension || 'n/a'}`
      );
    }

    enriched.push(resource);
  }

  return enriched;
}

function profileOf(resource) {
  const type = normalized(
    resource.resource_type
  );

  const subtype = normalized(
    resource.subtype
  );

  const sourceType = normalized(
    resource.sourcetype
  );

  const extension = extensionOf(resource);

  const mimeType = normalized(
    resource.mime_type
  );

  const hasGeometry =
    geometryValue(resource);

  if (
    subtype === 'remote' ||
    sourceType === 'remote'
  ) {
    return 'remote';
  }

  if (type === 'document') {
    if (
      extension === 'pdf' ||
      mimeType === 'application/pdf'
    ) {
      return 'pdf';
    }

    if (
      extension === 'txt' ||
      mimeType === 'text/plain'
    ) {
      return 'text';
    }

    return null;
  }

  if (type !== 'dataset') {
    return null;
  }

  if (subtype === 'raster') {
    return 'raster';
  }

  if (
    subtype === 'vector' &&
    hasGeometry === true
  ) {
    return 'vector';
  }

  if (
    subtype === 'vector' &&
    hasGeometry === false
  ) {
    return 'table';
  }

  return null;
}

function selectResources(
  resources,
  profiles
) {
  const selected = {};

  for (const resource of resources) {
    const profile = profileOf(resource);

    if (
      profile &&
      profiles.includes(profile) &&
      !selected[profile]
    ) {
      selected[profile] = {
        pk: String(resource.pk),
        title: String(resource.title || ''),
        resourceType: String(
          resource.resource_type || ''
        ),
        subtype: String(
          resource.subtype || ''
        ),
        extension: extensionOf(resource),
      };
    }
  }

  return selected;
}

function profileFilter(profile) {
  const filters = {
    raster:
      'filter%7Bresource_type.in%7D=dataset' +
      '&filter%7Bsubtype.in%7D=raster',

    vector:
      'filter%7Bresource_type.in%7D=dataset' +
      '&filter%7Bsubtype.in%7D=vector',

    table:
      'filter%7Bresource_type.in%7D=dataset' +
      '&filter%7Bsubtype.in%7D=vector',

    pdf:
      'filter%7Bresource_type.in%7D=document',

    text:
      'filter%7Bresource_type.in%7D=document',

    remote:
      'filter%7Bsubtype.in%7D=remote',
  };

  return filters[profile] || '';
}

export function setup() {
  const configuration = config();

  for (const profile of configuration.profiles) {
    if (!SUPPORTED_PROFILES.includes(profile)) {
      fail(`Perfil no soportado: ${profile}`);
    }
  }

  // El descubrimiento es público para seleccionar únicamente recursos que
  // todos los usuarios del pool puedan consultar. Cada VU sí autentica la
  // navegación posterior cuando el escenario lo solicita.
  const auth = null;

  const discoveryResponse = http.get(
    `${configuration.baseUrl}` +
      `${configuration.resourcesPath}` +
      `?page=1&page_size=${configuration.pageSize}`,
    requestOptions(auth, {
      scenario: 'catalog',
      operation: 'discover_resources',
      profile: 'discovery',
    })
  );

  const discoveryData = parseJson(
    discoveryResponse
  );

  const discoveryValid = check(
    discoveryResponse,
    {
      'descubrimiento: estado HTTP 200':
        (res) => res.status === 200,

      'descubrimiento: JSON válido':
        () => discoveryData !== null,

      'descubrimiento: contiene resources':
        () =>
          Array.isArray(
            discoveryData?.resources
          ),
    }
  );

  if (!discoveryValid) {
    fail('No fue posible consultar el catálogo');
  }

  const enriched = enrichResources(
    configuration.baseUrl,
    discoveryData.resources,
    auth
  );

  const selected = selectResources(
    enriched,
    configuration.profiles
  );

  for (const profile of configuration.profiles) {
    const resource = selected[profile];

    if (resource) {
      console.log(
        `[catalog] ${profile}: ` +
          `pk=${resource.pk}, ` +
          `title=${resource.title}, ` +
          `subtype=${resource.subtype || 'n/a'}, ` +
          `extension=${resource.extension || 'n/a'}`
      );

      continue;
    }

    const message =
      `[catalog] perfil omitido: ${profile}; ` +
      'no se encontró un recurso visible compatible';

    if (configuration.failIfMissing) {
      fail(message);
    }

    console.warn(message);
  }

  if (Object.keys(selected).length === 0) {
    fail('No se encontró ningún recurso compatible');
  }

  return {
    configuration,
    selected,
  };
}

export default function (data) {
  const {
    configuration,
    selected,
  } = data;

  // Una sesión independiente por VU, reutilizada entre sus iteraciones.
  const auth = configuration.authenticated
    ? authenticatedSession()
    : null;

  const catalogPageOptions = requestOptions(
    auth,
    {
      scenario: 'catalog',
      operation: 'open_catalog',
      profile: 'general',
    }
  );

  // Nuxt puede normalizar la ruta mediante redirección.
  catalogPageOptions.redirects = 5;

  const catalogPage = http.get(
    `${configuration.baseUrl}` +
      `${configuration.viewerBase}/catalogo`,
    catalogPageOptions
  );

  check(catalogPage, {
    'catálogo: estado HTTP 200':
      (res) => res.status === 200,

    'catálogo: respuesta HTML':
      (res) =>
        String(
          res.headers['Content-Type'] || ''
        )
          .toLowerCase()
          .includes('text/html'),

    'catálogo: no termina en error de autenticación':
      (res) =>
        !String(res.url || '')
          .includes('/api/auth/error'),
  });

  sleep(1);

  for (const profile of configuration.profiles) {
    const resource = selected[profile];

    if (!resource) {
      continue;
    }

    const filterResponse = http.get(
      `${configuration.baseUrl}` +
        `${configuration.resourcesPath}` +
        `?${profileFilter(profile)}` +
        '&page=1&page_size=10',
      requestOptions(auth, {
        scenario: 'catalog',
        operation: 'filter_resources',
        profile,
      })
    );

    const filterData = parseJson(filterResponse);

    check(filterResponse, {
      [`${profile}: filtro HTTP 200`]:
        (res) => res.status === 200,

      [`${profile}: filtro JSON válido`]:
        () => filterData !== null,

      [`${profile}: filtro con resources`]:
        () =>
          Array.isArray(
            filterData?.resources
          ),
    });

    sleep(1);

    const term = encodeURIComponent(
      searchTerm(resource.title)
    );

    const searchResponse = http.get(
      `${configuration.baseUrl}` +
        `${configuration.resourcesPath}` +
        '?search_fields=title' +
        '&search_fields=abstract' +
        `&search=${term}`,
      requestOptions(auth, {
        scenario: 'catalog',
        operation: 'search_resources',
        profile,
      })
    );

    const searchData = parseJson(searchResponse);

    check(searchResponse, {
      [`${profile}: búsqueda HTTP 200`]:
        (res) => res.status === 200,

      [`${profile}: búsqueda JSON válida`]:
        () => searchData !== null,

      [`${profile}: recurso localizado`]:
        () =>
          Array.isArray(
            searchData?.resources
          ) &&
          searchData.resources.some(
            (item) =>
              String(item.pk) === resource.pk
          ),
    });

    sleep(1);

    const detailResponse = http.get(
      detailUrl(
        configuration.baseUrl,
        resource
      ),
      requestOptions(auth, {
        scenario: 'catalog',
        operation: 'resource_detail',
        profile,
        resource_id: resource.pk,
      })
    );

    const detailData = parseJson(detailResponse);
    const detail = detailObject(detailData);

    check(detailResponse, {
      [`${profile}: detalle HTTP 200`]:
        (res) => res.status === 200,

      [`${profile}: detalle JSON válido`]:
        () => detailData !== null,

      [`${profile}: detalle correcto`]:
        () =>
          String(
            detail?.pk ??
              detail?.id
          ) === resource.pk,
    });

    sleep(1);

    if (
      configuration.includeStyles &&
      resource.resourceType === 'dataset'
    ) {
      const stylesResponse = http.get(
        `${configuration.baseUrl}` +
          `/api/v2/datasets/${resource.pk}/` +
          'sldstyles/',
        requestOptions(auth, {
          scenario: 'catalog',
          operation: 'resource_styles',
          profile,
          resource_id: resource.pk,
        })
      );

      check(stylesResponse, {
        [`${profile}: estilos HTTP 200`]:
          (res) => res.status === 200,

        [`${profile}: estilos JSON`]:
          (res) =>
            String(
              res.headers['Content-Type'] || ''
            )
              .toLowerCase()
              .includes('application/json'),
      });
    }
  }
}
