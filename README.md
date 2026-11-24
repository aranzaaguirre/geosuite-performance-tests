# GeoSuite Performance Tests

Repositorio de pruebas de rendimiento de GeoSuite basado en Grafana k6.
Contiene escenarios que reproducen los flujos principales de la plataforma.
El perfil predeterminado usa un usuario virtual y una iteración para validar
las solicitudes antes de aplicar carga, estrés o picos.

## Documentación

- [Detalle de escenarios](docs/SCENARIOS.md)
- [Guía de reproducción por ambiente](docs/REPRODUCIBILITY.md)
- [Política de seguridad](SECURITY.md)
- [Guía de contribución](CONTRIBUTING.md)

## Inicio rápido

```bash
cp config/local.env.example config/local.env
chmod 600 config/local.env
nano config/local.env
```

Después de instalar k6 y preparar las credenciales:

```bash
export K6_BIN="$PWD/.tools/k6-v2.3.0-linux-amd64/k6"

set -a
source config/local.env
set +a

"$K6_BIN" run scenarios/00-smoke.js
```

No ejecutes perfiles intensivos hasta que `functional` y `baseline` sean
correctos y el ambiente esté autorizado.

## Alcance

| Escenario | Flujo validado | Efecto sobre el ambiente |
| --- | --- | --- |
| `00-smoke.js` | Disponibilidad del catálogo API | Solo lectura |
| `01-auth.js` | NextAuth, Keycloak OIDC y perfil GeoNode | Crea una sesión |
| `02-catalog.js` | Descubrimiento, filtros, búsquedas y detalles | Solo lectura |
| `03-maps.js` | Visor, mapas, capas, WMTS/MVT, WMS y WFS | Solo lectura |
| `04-upload.js` | Carga, análisis, importación y publicación | Depende de `UPLOAD_MODE` |

Los escenarios ejercitan Nginx, Nuxt, Keycloak, Django/GeoNode, Celery,
GeoServer y PostgreSQL/PostGIS según el flujo. No sustituyen las métricas
internas de CPU, memoria, disco, base de datos o contenedores.

## Estructura

```text
├── config/       Variables por ambiente
├── data/         Datos sintéticos versionables
├── docs/         Diseño de escenarios y reproducción
├── lib/          Funciones compartidas, incluida autenticación
├── results/      Salidas generadas; no se versionan
├── scenarios/    Escenarios funcionales k6
└── scripts/      Aprovisionamiento e inicialización de usuarios
```

El binario descargado en `.tools/` es local y está excluido de Git. En otra
máquina debe instalarse o copiarse un binario compatible con su arquitectura.

## Reproducir las pruebas en cualquier instancia

Esta sección permite preparar Linux, Nimbus, IDCE u otra instalación de GeoSuite
sin modificar los escenarios. Cada instancia utiliza su propio archivo de
configuración, pool de usuarios y directorio de resultados.

### 1. Clonar una versión identificable

```bash
git clone URL_DEL_REPOSITORIO geosuite-performance-tests
cd geosuite-performance-tests
git rev-parse HEAD
```

Registra el commit mostrado junto con los resultados para poder repetir
exactamente la misma versión de los scripts.

### 2. Instalar k6

Instala k6 para la arquitectura del generador de carga o coloca un binario
compatible dentro de `.tools/`. La versión validada por este repositorio es
`v2.3.0`.

```bash
uname -m
k6 version
```

Si el binario está dentro del repositorio:

```bash
export K6_BIN="$PWD/.tools/k6-v2.3.0-linux-amd64/k6"
"$K6_BIN" version
```

Si k6 está instalado en el sistema:

```bash
export K6_BIN="$(command -v k6)"
```

El generador debe ser, preferentemente, una máquina Linux separada del
servidor GeoSuite para que k6 no compita por CPU o RAM con el sistema evaluado.

### 3. Crear la configuración privada

Sustituye `AMBIENTE` por `linux`, `nimbus`, `idce` u otro identificador:

```bash
cp config/local.env.example config/AMBIENTE.env
chmod 600 config/AMBIENTE.env
nano config/AMBIENTE.env
```

Configura como mínimo:

```env
TEST_ENV_NAME=AMBIENTE
BASE_URL=https://dominio-real-de-geosuite
OIDC_ISSUER=https://dominio-real-de-geosuite/iam/realms/REALM
KEYCLOAK_CLIENT_ID=CLIENTE_OIDC_REAL
AUTH_USERS_FILE=../config/users.AMBIENTE.json
```

También deben revisarse las rutas `AUTH_*`, los prefijos, la entrada de
GeoServer y las opciones de catálogo, mapas y carga. No copies valores locales
sin verificarlos contra la configuración real de la instancia.

En servidores reales utiliza HTTPS y certificados válidos. No uses
`--insecure-skip-tls-verify` como solución a un certificado incorrecto.

### 4. Verificar conectividad antes de k6

```bash
set -a
source config/AMBIENTE.env
set +a
```

```bash
curl -fsSI "$BASE_URL"
```

```bash
curl -fsS \
  "$BASE_URL/api/v2/sigic-resources/?page=1&page_size=1" \
  | python3 -m json.tool \
  | head -40
```

```bash
curl -fsS \
  "$OIDC_ISSUER/.well-known/openid-configuration" \
  | python3 -m json.tool \
  | head -60
```

Detente si DNS, TLS, API u OIDC no responden correctamente.

### 5. Preparar un pool independiente de usuarios

Cada VU autenticado necesita una cuenta diferente. Crea el archivo privado:

```bash
nano config/users.AMBIENTE.json
chmod 600 config/users.AMBIENTE.json
```

Formato:

```json
[
  {
    "username": "usuario-prueba-001",
    "password": "credencial-privada"
  }
]
```

Si existe autorización administrativa, el pool puede generarse con:

```bash
./scripts/provision-users.sh
```

El aprovisionador solicita el archivo del ambiente, la cantidad de cuentas y
la credencial administrativa. No lo uses contra una instancia sin permiso.

Cantidad mínima:

| Ejecución | Cuentas necesarias |
| --- | ---: |
| `functional` | 1 |
| `baseline` | `PROFILE_VUS` |
| `load`, `spike`, `recovery` | máximo objetivo |
| `stress` | `3 × PROFILE_VUS` |

### 6. Inicializar perfiles de GeoSuite

Las cuentas pueden existir en Keycloak sin tener todavía perfil en
Django/GeoNode. Ejecuta una autenticación secuencial por cuenta:

```bash
"$K6_BIN" run scripts/initialize-users.js
```

Debe finalizar con `auth_session_valid=100%`, checks al 100% y cero errores
HTTP. Si aparecen sesiones vacías o acciones requeridas de Keycloak, no
continúes con carga.

### 7. Ejecutar la puerta funcional

Ejecuta en orden y corrige cualquier fallo antes del siguiente paso:

```bash
TEST_PROFILE=functional \
  "$K6_BIN" run scenarios/00-smoke.js

TEST_PROFILE=functional \
  "$K6_BIN" run scenarios/01-auth.js

TEST_PROFILE=functional CATALOG_AUTHENTICATED=true \
  "$K6_BIN" run scenarios/02-catalog.js

TEST_PROFILE=functional MAP_AUTHENTICATED=true \
  "$K6_BIN" run scenarios/03-maps.js

TEST_PROFILE=functional UPLOAD_MODE=analyze UPLOAD_CLEANUP_JOB=true \
  "$K6_BIN" run scenarios/04-upload.js
```

Para mapas debe existir un mapa visible con una capa realmente publicada en
GeoServer. Para carga debe existir cuota y el archivo sintético configurado.

### 8. Obtener una línea base

Después de aprobar la puerta funcional:

```bash
mkdir -p results/AMBIENTE/baseline-catalog-001
```

```bash
TEST_PROFILE=baseline \
PROFILE_VUS=3 \
PROFILE_DURATION=2m \
"$K6_BIN" run \
  --summary-export=results/AMBIENTE/baseline-catalog-001/summary.json \
  scenarios/02-catalog.js
```

Los valores son conservadores y deben ajustarse únicamente con autorización.
No ejecutes `load`, `stress`, `spike` o `recovery` en producción ni antes de
contar con monitoreo y condiciones de detención.

### 9. Conservar evidencia reproducible

Por cada ejecución registra:

- commit de este repositorio;
- versión y arquitectura de k6;
- nombre del ambiente y configuración no sensible;
- inicio, fin y zona horaria;
- escenario, perfil, VUs y duración;
- `summary.json`;
- CPU, RAM, disco, red, reinicios y logs del servidor;
- CPU y RAM del generador de carga;
- hallazgos funcionales observados.

Los archivos de `results/` están excluidos de Git. Guárdalos en el repositorio
de evidencias autorizado para el proyecto.

### 10. Orden de promoción

```text
functional → baseline → load → stress → spike → recovery
```

Y entre instalaciones:

```text
Linux controlado → Nimbus → IDCE
```

No avances si existen sesiones inválidas, checks funcionales fallidos, capas
inexistentes, errores crecientes, saturación del generador o recuperación
incompleta. La guía ampliada se encuentra en
[`docs/REPRODUCIBILITY.md`](docs/REPRODUCIBILITY.md).

## Configuración por ambiente

`config/local.env.example` es la plantilla versionable. Para cada ambiente se
crea un archivo privado equivalente, por ejemplo `local.env`, `nimbus.env` o
`idce.env`. Los archivos `*.env` reales están excluidos de Git y deben tener
permisos `600`.

| Grupo | Variables | Finalidad |
| --- | --- | --- |
| Destino | `BASE_URL` | Origen público de GeoSuite, sin `/` final |
| Prefijos | `ADMIN_BASE`, `APP_BASE`, `API_BASE` | Entradas de Nginx y API |
| OIDC | `OIDC_ISSUER`, `KEYCLOAK_CLIENT_ID` | Emisor y cliente administrativo |
| Sesión | `AUTH_*` | Rutas NextAuth, perfil protegido y credenciales privadas |
| Catálogo | `CATALOG_*`, `DISCOVERY_PAGE_SIZE` | Acceso, perfiles y descubrimiento |
| Mapas | `MAP_*`, `GEOSERVER_BASE` | Selección, capas y solicitudes OGC |
| Carga | `UPLOAD_*` | Archivo, polling, limpieza y publicación |

En local se usa la URL definida por la instalación. Nimbus e IDCE deben usar
su URL HTTPS real. Las credenciales administrativas de GeoServer no pertenecen
a estos archivos: son secretos internos de la infraestructura.

> **Compatibilidad de API:** algunas rutas del backend conservan los nombres
> técnicos heredados `sigic-resources` y `sigic-maps`. Son contratos HTTP de la
> plataforma y no representan la identidad pública de este repositorio. No se
> renombran porque hacerlo rompería las solicitudes contra las instalaciones
> existentes.

Para cargar una configuración en Bash:

```bash
set -a
source config/local.env
set +a
```

No debe ejecutarse `source .env` sobre el archivo principal de Docker Compose;
su sintaxis y finalidad son diferentes.

## Usuarios de prueba

El aprovisionador crea o actualiza un conjunto de cuentas exclusivas en
Keycloak y genera el archivo privado que k6 asigna por posición a cada VU. No
se ejecuta automáticamente con una prueba, porque crear cuentas es una tarea
administrativa separada.

Desde la raíz del repositorio:

```bash
./scripts/provision-users.sh
```

El asistente solicita la ruta del mismo archivo `.env` utilizado para ejecutar
las pruebas y la cantidad de usuarios. La ubicación, realm, modo de acceso y
cuenta administrativa de Keycloak se leen de ese archivo; no se deducen del
nombre del ambiente. La contraseña administrativa se solicita de forma oculta
si no fue proporcionada temporalmente en `KC_ADMIN_PASSWORD`.

Cada archivo de ambiente declara `KEYCLOAK_ADMIN_MODE`,
`KEYCLOAK_ADMIN_URL`, `KEYCLOAK_REALM`, `KC_ADMIN_USERNAME` y
`KC_ADMIN_REALM`. Desde un generador Linux contra Nimbus o IDCE normalmente se
usa `KEYCLOAK_ADMIN_MODE=local` y la URL HTTPS real. El secreto
`KC_ADMIN_PASSWORD` se proporciona temporalmente o mediante la captura oculta;
nunca debe guardarse en el archivo ni registrarse en Git.

Para `local` con tres usuarios, el resultado es
`config/users.local.json`; además, el script configura en `config/local.env`:

```text
AUTH_USERS_FILE=../config/users.local.json
```

El JSON tiene permisos `600`, está excluido de Git y no debe compartirse. El
script es idempotente respecto al nombre: si una cuenta ya existe, la conserva
y renueva su contraseña. También completa nombre y apellido sintéticos porque
el perfil estándar del realm los exige antes de finalizar el login. La
plantilla `config/users.example.json` documenta el formato sin contener
credenciales utilizables.

Después del aprovisionamiento, las cuentas existen en Keycloak pero su perfil
de Django/GeoNode puede no existir todavía. El inicializador ejecuta una sola
autenticación OIDC por cuenta para provocar la sincronización normal de GeoSuite:

```bash
set -a
source config/local.env
set +a

"$K6_BIN" run scripts/initialize-users.js
```

Este procedimiento usa un solo VU y recorre secuencialmente todas las entradas
del pool. Ejecuta exactamente un login por cuenta, sin introducir concurrencia.
No es una prueba de carga y no debe utilizarse para medir capacidad.

Debe existir al menos una cuenta por VU simultáneo. Para `baseline`, `load`,
`spike` y `recovery`, el mínimo es el máximo objetivo configurado. Para
`stress`, el máximo actual es `3 x PROFILE_VUS`; por ejemplo, con
`PROFILE_VUS=10` deben aprovisionarse 30 cuentas. k6 detiene la ejecución si
el pool es menor, evitando sesiones concurrentes con el mismo usuario.

## Ejecución funcional

Desde la raíz del repositorio:

```bash
export K6_BIN="$PWD/.tools/k6-v2.3.0-linux-amd64/k6"
```

Después se ejecuta el escenario deseado:

```bash
"$K6_BIN" run scenarios/00-smoke.js
"$K6_BIN" run scenarios/01-auth.js
"$K6_BIN" run scenarios/02-catalog.js
"$K6_BIN" run scenarios/03-maps.js
"$K6_BIN" run scenarios/04-upload.js
```

`CATALOG_AUTHENTICATED` y `MAP_AUTHENTICATED` seleccionan las entradas
`/admin` o `/app`. La modalidad autenticada es la validada por defecto.

## Perfiles de ejecución

`TEST_PROFILE` selecciona la forma de la carga sin cambiar el flujo de usuario:

| Perfil | Ejecutor | Propósito |
| --- | --- | --- |
| `functional` | 1 VU, 1 iteración | Validar solicitudes y datos |
| `baseline` | VUs constantes | Obtener la referencia de carga baja |
| `load` | Rampa y sostenimiento | Evaluar la carga objetivo |
| `stress` | Tres escalones | Buscar degradación progresiva |
| `spike` | Incremento rápido | Evaluar un pico repentino |
| `recovery` | Carga alta y reducción | Verificar recuperación |

Los valores locales iniciales son conservadores: `baseline` usa 3 VUs durante
2 minutos y los perfiles de rampa parten de `PROFILE_VUS=3`. Antes de ejecutar
en Nimbus o IDCE deben definirse valores acordes con la capacidad esperada y
la autorización del ambiente.

Ejemplo de línea base local:

```bash
TEST_PROFILE=baseline \
  "$K6_BIN" run scenarios/02-catalog.js
```

Las variables `PROFILE_STAGE_DURATION`, `PROFILE_HOLD_DURATION` y
`PROFILE_RECOVERY_DURATION` controlan las etapas. `PROFILE_BASE_VUS` define la
carga normal usada por pico y recuperación. `PROFILE_P95_MS` permite sustituir
el límite de latencia de un escenario sin editar código.

Umbrales iniciales:

- checks satisfactorios superiores al 99 %;
- solicitudes HTTP fallidas inferiores al 1 %;
- p95 menor de 2 s para autenticación y catálogo;
- p95 menor de 3 s para mapas;
- p95 menor de 5 s para carga y análisis.

Estos límites son criterios técnicos iniciales y deberán revisarse después de
la línea base o sustituirse por requisitos formales de servicio.

`00-smoke.js` permanece deliberadamente fijo en una iteración. En catálogo,
mapas y carga cada VU inicia sesión una vez y la reutiliza; `01-auth.js` inicia
una sesión por iteración porque mide específicamente el proceso de login.
El descubrimiento previo del catálogo usa únicamente recursos públicos,
evitando seleccionar elementos privados de una cuenta administrativa que los
usuarios del pool no podrían consultar.

## Carga de archivos

`04-upload.js` dispone de dos modos:

- `analyze`: modo predeterminado. Carga, analiza, previsualiza y elimina el job
  temporal. Genera nombres únicos por VU e iteración.
- `full`: importa a GeoNode, verifica WMS/WFS y puede finalizar metadatos.
  Crea un dataset persistente y debe ejecutarse de forma controlada.

Ejemplo seguro:

```bash
UPLOAD_MODE=analyze \
  "$K6_BIN" run scenarios/04-upload.js
```

No se debe usar `UPLOAD_MODE=full` como carga concurrente. Su publicación
requiere que GeoNode/Celery pueda acceder a GeoServer REST y que el datastore
PostGIS de GeoServer tenga credenciales válidas.

El script rechaza automáticamente cualquier combinación de
`UPLOAD_MODE=full` con un perfil distinto de `functional`.

## Seguridad y reproducibilidad

- No versionar usuarios, contraseñas, tokens ni resultados con datos reales.
- Utilizar cuentas exclusivas para pruebas y permisos mínimos suficientes.
- No desactivar la validación TLS para resolver certificados incorrectos.
- Revisar y retirar los datasets creados por ejecuciones `full`.
- Ejecutar estrés formal desde un generador Linux separado del sistema bajo
  prueba; la ejecución local se reserva para validación y línea base pequeña.

En los perfiles de carga, cada VU deberá autenticarse una vez y reutilizar su
sesión. La capacidad específica de inicio de sesión se medirá separadamente
con `01-auth.js`, evitando que Keycloak distorsione todas las métricas de
catálogo y mapas.
