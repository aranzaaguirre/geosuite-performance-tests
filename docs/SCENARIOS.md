# Escenarios de prueba

Los escenarios modelan solicitudes HTTP reales de GeoSuite. No son pruebas de
navegador: validan protocolos, APIs y servicios OGC sin medir renderizado del
DOM, JavaScript del cliente o Web Vitals.

Las rutas `sigic-resources` y `sigic-maps` se conservan únicamente como
identificadores técnicos heredados de la API actualmente desplegada.

## Convenciones comunes

- `BASE_URL` define el origen del ambiente y no lleva `/` final.
- Los escenarios autenticados usan NextAuth, Keycloak OIDC con Authorization
  Code + PKCE y el perfil protegido de Django/GeoNode.
- Cada VU recibe una cuenta distinta del archivo `AUTH_USERS_FILE`.
- Los checks verifican tanto estado HTTP como contenido funcional.
- Los tags `scenario`, `operation` y `profile` permiten separar métricas.
- Ningún escenario debe desactivar la validación TLS.

## 00-smoke.js — disponibilidad

**Objetivo:** comprobar que Nginx y la API de GeoNode responden antes de una
prueba más costosa.

**Flujo:**

1. `GET /api/v2/sigic-resources/`.
2. Validación de HTTP 200.
3. Validación de cuerpo JSON no vacío.

**Autenticación:** no requerida.

**Efectos:** solo lectura. El escenario permanece fijo en 1 VU y 1 iteración.

## 01-auth.js — autenticación OIDC

**Objetivo:** medir exclusivamente la capacidad y confiabilidad del login.

**Flujo:**

1. `GET /admin/api/auth/csrf`.
2. `POST /admin/api/auth/signin/keycloak`.
3. Redirección al endpoint de autorización del realm.
4. Envío del formulario de Keycloak.
5. Callback de NextAuth con `code` y `state`.
6. `GET /admin/api/auth/session`.
7. `GET /api/v2/account/me/profile/` con Bearer token.

**Componentes:** Nginx, frontend administrativo, NextAuth, Keycloak y
Django/GeoNode.

**Efectos:** crea sesiones; no modifica recursos de catálogo.

**Criterio principal:** `auth_session_valid=100%`.

## 02-catalog.js — navegación del catálogo

**Objetivo:** reproducir listado, filtros, búsquedas y detalle de recursos.

**Flujo:**

1. Descubrimiento público de recursos visibles.
2. Clasificación automática por raster, vector, tabla, PDF, texto o remoto.
3. Apertura de `/admin/catalogo` o `/app/catalogo`.
4. Filtro por perfil mediante `/api/v2/sigic-resources/`.
5. Búsqueda por título y resumen.
6. Consulta de `/api/v2/datasets/{id}/` o `/api/v2/documents/{id}/`.

**Autenticación:** configurable con `CATALOG_AUTHENTICATED`.

**Efectos:** solo lectura.

**Portabilidad:** no usa IDs fijos. Los perfiles ausentes pueden omitirse con
`FAIL_IF_PROFILE_MISSING=false`.

## 03-maps.js — mapas y servicios geoespaciales

**Objetivo:** validar un flujo real de visualización de mapas y capas.

**Flujo:**

1. Listado y detalle mediante `/api/v2/sigic-maps/`.
2. Apertura del visor Nuxt.
3. Consulta del dataset asociado.
4. Lectura de GetCapabilities.
5. Uso de WMTS/MVT cuando la capa está anunciada.
6. Fallback a WMS GetMap.
7. WFS/consulta de interacción cuando corresponde.

**Autenticación:** configurable con `MAP_AUTHENTICATED`.

**Precondición:** debe existir un mapa visible que contenga al menos una capa
realmente publicada en GeoServer. Una respuesta HTTP 200 con excepción OGC no
se considera imagen válida.

**Efectos:** solo lectura.

## 04-upload.js — carga y procesamiento

**Objetivo:** evaluar recepción, análisis e importación de archivos.

### Modo `analyze`

1. Consulta de cuota.
2. Upload multipart del archivo sintético.
3. Polling del análisis.
4. Validación de esquema, estrategia geográfica y preview.
5. Eliminación del job temporal cuando `UPLOAD_CLEANUP_JOB=true`.

Es el modo permitido para pruebas concurrentes controladas.

### Modo `full`

Además del análisis:

1. Importa el dataset en GeoNode/PostGIS.
2. Verifica publicación WMS y WFS en GeoServer.
3. Puede finalizar metadatos.

Este modo crea datos persistentes. El código impide combinarlo con perfiles
distintos de `functional`.

## Perfiles de ejecución

| Perfil | Comportamiento | Uso |
| --- | --- | --- |
| `functional` | 1 VU, 1 iteración | Validación previa |
| `baseline` | VUs constantes | Referencia de baja carga |
| `load` | Rampa, sostenimiento y descenso | Carga esperada |
| `stress` | Tres escalones hasta `3 × PROFILE_VUS` | Límite y degradación |
| `spike` | Aumento y reducción abruptos | Picos de acceso |
| `recovery` | Carga alta, reducción y observación | Recuperación |

`stress`, `spike` y cargas altas requieren autorización, monitoreo del servidor
y un generador separado del sistema bajo prueba.
