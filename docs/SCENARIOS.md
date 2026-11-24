# Escenarios

Esta guía explica los recorridos implementados en k6, los componentes
involucrados y las condiciones necesarias para interpretar cada resultado.
Los escenarios reproducen tráfico HTTP real de GeoSuite; no automatizan un
navegador ni miden renderizado, DOM o Web Vitals.

Las rutas `sigic-resources` y `sigic-maps` se conservan únicamente como
identificadores técnicos heredados de la API actualmente desplegada.

## Navegación

| Escenario | Propósito | Impacto |
| --- | --- | --- |
| [00 — Disponibilidad](#00-smokejs--disponibilidad) | Confirmar acceso mínimo | Lectura |
| [01 — Autenticación](#01-authjs--autenticación-oidc) | Crear y validar una sesión OIDC | Sesión |
| [02 — Catálogo](#02-catalogjs--navegación-del-catálogo) | Consultar y descubrir recursos | Lectura |
| [03 — Mapas](#03-mapsjs--mapas-y-servicios-geoespaciales) | Consumir mapas y servicios OGC | Lectura |
| [04 — Carga](#04-uploadjs--carga-y-procesamiento) | Analizar o importar archivos | Condicional |

## Funcionamiento común

El escenario define el recorrido del usuario; el perfil define la concurrencia
y la duración. Las operaciones no cambian entre `functional` y `baseline`: lo
que cambia es cuántos usuarios las ejecutan y durante cuánto tiempo.

- `BASE_URL` define el origen del ambiente y no lleva `/` final.
- Los escenarios autenticados usan NextAuth, Keycloak OIDC con Authorization
  Code + PKCE y el perfil protegido de Django/GeoNode.
- Cada VU recibe una cuenta distinta del archivo `AUTH_USERS_FILE`.
- Los checks verifican tanto estado HTTP como contenido funcional.
- Los tags `scenario`, `operation` y `profile` permiten separar métricas.
- Ningún escenario debe desactivar la validación TLS.

## 00-smoke.js — disponibilidad

Archivo: [`scenarios/00-smoke.js`](../scenarios/00-smoke.js)

| Campo | Descripción |
| --- | --- |
| **Objetivo** | Comprobar la disponibilidad antes de un recorrido más costoso. |
| **Usuario** | Visitante que solicita el catálogo por primera vez. |
| **Autenticación** | No requerida. |
| **Componentes** | DNS, Nginx y Django/GeoNode. |
| **Impacto** | Solo lectura; 1 VU y 1 iteración fijos. |

### Recorrido

1. `GET /api/v2/sigic-resources/`.
2. Validación de HTTP 200.
3. Validación de cuerpo JSON no vacío.

### Resultado esperado

- HTTP 200.
- Cuerpo no vacío.
- Tipo de contenido JSON.

## 01-auth.js — autenticación OIDC

Archivo: [`scenarios/01-auth.js`](../scenarios/01-auth.js)

| Campo | Descripción |
| --- | --- |
| **Objetivo** | Medir la confiabilidad y latencia del inicio de sesión completo. |
| **Usuario** | Persona que accede al módulo administrativo. |
| **Autenticación** | Es el proceso evaluado. |
| **Componentes** | Nginx, NextAuth, Keycloak y Django/GeoNode. |
| **Impacto** | Crea sesiones; no modifica recursos del catálogo. |

### Recorrido

1. `GET /admin/api/auth/csrf`.
2. `POST /admin/api/auth/signin/keycloak`.
3. Redirección al endpoint de autorización del realm.
4. Envío del formulario de Keycloak.
5. Callback de NextAuth con `code` y `state`.
6. `GET /admin/api/auth/session`.
7. `GET /api/v2/account/me/profile/` con Bearer token.

### Resultado esperado

- Flujo CSRF y PKCE válido.
- Callback sin error de autenticación.
- Sesión con usuario y access token.
- Perfil Django/GeoNode correspondiente a la cuenta.
- `auth_session_valid=100%`.

## 02-catalog.js — navegación del catálogo

Archivo: [`scenarios/02-catalog.js`](../scenarios/02-catalog.js)

| Campo | Descripción |
| --- | --- |
| **Objetivo** | Evaluar navegación, filtros, búsqueda y detalle de recursos. |
| **Usuario** | Visitante o usuario autenticado que explora contenido. |
| **Autenticación** | Configurable con `CATALOG_AUTHENTICATED`. |
| **Componentes** | Nginx, Nuxt, Django/GeoNode y PostgreSQL. |
| **Impacto** | Solo lectura. |

### Recorrido

1. Descubrimiento público de recursos visibles.
2. Clasificación automática por raster, vector, tabla, PDF, texto o remoto.
3. Apertura de `/admin/catalogo` o `/app/catalogo`.
4. Filtro por perfil mediante `/api/v2/sigic-resources/`.
5. Búsqueda por título y resumen.
6. Consulta de `/api/v2/datasets/{id}/` o `/api/v2/documents/{id}/`.

### Datos y portabilidad

No usa IDs fijos: descubre recursos visibles en cada ejecución. Los perfiles
ausentes pueden omitirse con `FAIL_IF_PROFILE_MISSING=false`.

### Resultado esperado

- Listado, filtro, búsqueda y detalle con HTTP 200.
- Respuestas API con JSON válido.
- Recurso localizado y detalle correspondiente al mismo ID.
- Entrada del catálogo con HTML válido.

## 03-maps.js — mapas y servicios geoespaciales

Archivo: [`scenarios/03-maps.js`](../scenarios/03-maps.js)

| Campo | Descripción |
| --- | --- |
| **Objetivo** | Validar que un mapa registrado pueda visualizar sus capas publicadas. |
| **Usuario** | Visitante o usuario autenticado que abre un mapa. |
| **Autenticación** | Configurable con `MAP_AUTHENTICATED`. |
| **Componentes** | Nginx, Nuxt, GeoNode, GeoServer y PostGIS. |
| **Impacto** | Solo lectura. |

### Recorrido

1. Listado y detalle mediante `/api/v2/sigic-maps/`.
2. Apertura del visor Nuxt.
3. Consulta del dataset asociado.
4. Lectura de GetCapabilities.
5. Uso de WMTS/MVT cuando la capa está anunciada.
6. Fallback a WMS GetMap.
7. WFS/consulta de interacción cuando corresponde.

### Datos y precondiciones

Debe existir un mapa visible que contenga al menos una capa
realmente publicada en GeoServer. Una respuesta HTTP 200 con excepción OGC no
se considera imagen válida.

### Resultado esperado

- Listado, visor, detalle y dataset accesibles.
- GetCapabilities válido.
- Tesela WMTS/MVT o imagen WMS no vacía.
- Respuesta de interacción coherente cuando está habilitada.

## 04-upload.js — carga y procesamiento

Archivo: [`scenarios/04-upload.js`](../scenarios/04-upload.js)

| Campo | Descripción |
| --- | --- |
| **Objetivo** | Evaluar recepción, análisis asíncrono e importación de archivos. |
| **Usuario** | Usuario autenticado que incorpora información. |
| **Autenticación** | Requerida. |
| **Componentes** | Nginx, Django/GeoNode, Celery, PostgreSQL/PostGIS y GeoServer. |
| **Impacto** | Temporal en `analyze`; persistente en `full`. |

### Recorrido común

1. Consulta de cuota.
2. Upload multipart del archivo sintético.
3. Polling del análisis.
4. Validación de esquema, estrategia geográfica y preview.

### Modo `analyze`

- No importa un dataset.
- Elimina el job temporal cuando `UPLOAD_CLEANUP_JOB=true`.
- Es el modo permitido para concurrencia controlada.

### Modo `full`

- Importa el dataset en GeoNode/PostGIS.
- Verifica publicación WMS y WFS en GeoServer.
- Puede finalizar metadatos.
- Solo se permite con `TEST_PROFILE=functional`.

> [!CAUTION]
> El modo `full` crea datos persistentes. Requiere autorización y un
> procedimiento para revisar o retirar el dataset.

### Resultado esperado

- Cuota suficiente.
- Upload aceptado y job creado.
- Análisis terminado dentro del timeout.
- Preview coherente con el archivo.
- En `full`, dataset creado y servicios WMS/WFS funcionales.

## Perfiles

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

## Alcance de los resultados

- k6 mide latencia y errores observados desde el generador.
- Los escenarios no miden renderizado ni interacción visual del navegador.
- CPU, RAM, disco, red, contenedores y base de datos requieren monitoreo
  adicional.
- La causa de una degradación se determina correlacionando k6 con métricas y
  logs de la plataforma.
