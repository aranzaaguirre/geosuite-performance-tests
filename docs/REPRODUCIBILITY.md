# Reproducción por ambiente

## 1. Requisitos

- Linux x86_64 o ARM64.
- k6 compatible con la arquitectura; la versión validada es `v2.3.0`.
- Bash, curl, Python 3 y OpenSSL.
- Resolución DNS y certificado TLS válido para el ambiente.
- Cuentas de prueba autorizadas, una por VU concurrente.
- Acceso administrativo a Keycloak solo si se usará el aprovisionador.

## 2. Clonar y configurar

```bash
git clone URL_DEL_REPOSITORIO geosuite-performance-tests
cd geosuite-performance-tests

cp config/local.env.example config/linux.env
chmod 600 config/linux.env
nano config/linux.env
```

Configura como mínimo `TEST_ENV_NAME`, `BASE_URL`, `OIDC_ISSUER`,
`KEYCLOAK_CLIENT_ID` y `AUTH_USERS_FILE`. En Nimbus e IDCE, `BASE_URL` y
`OIDC_ISSUER` deben usar el dominio HTTPS real.

## 3. Pool de usuarios

El formato privado está documentado en `config/users.example.json`. También
puede generarse con autorización:

```bash
./scripts/provision-users.sh
```

El archivo generado debe conservar permisos `600` y nunca versionarse.

Inicializa los perfiles de Django/GeoNode una sola vez:

```bash
export K6_BIN="$PWD/.tools/k6-v2.3.0-linux-amd64/k6"

set -a
source config/linux.env
set +a

"$K6_BIN" run scripts/initialize-users.js
```

## 4. Puerta funcional

Ejecuta en orden:

```bash
"$K6_BIN" run scenarios/00-smoke.js
"$K6_BIN" run scenarios/01-auth.js
"$K6_BIN" run scenarios/02-catalog.js
"$K6_BIN" run scenarios/03-maps.js

UPLOAD_MODE=analyze \
  "$K6_BIN" run scenarios/04-upload.js
```

No continúes si hay sesiones vacías, capas inexistentes, checks fallidos o
errores HTTP.

## 5. Baseline reproducible

```bash
mkdir -p results/linux/baseline-catalog

TEST_PROFILE=baseline \
PROFILE_VUS=3 \
PROFILE_DURATION=2m \
"$K6_BIN" run \
  --summary-export=results/linux/baseline-catalog/summary.json \
  scenarios/02-catalog.js
```

Registra junto al resultado:

- commit del repositorio;
- versión de k6;
- archivo de ambiente usado, sin secretos;
- fecha y zona horaria;
- CPU, RAM y sistema operativo del generador y del servidor;
- métricas y logs de infraestructura.

## 6. Orden de ambientes

```text
Linux controlado → Nimbus → IDCE
```

En cada ambiente repite functional y baseline antes de carga progresiva. No
copies usuarios ni secretos entre ambientes sin autorización.

## 7. Criterios iniciales

- `auth_session_valid = 100%`;
- checks superiores al 99%;
- HTTP fallido inferior al 1%;
- p95 menor de 2 s para autenticación y catálogo;
- p95 menor de 3 s para mapas;
- p95 menor de 5 s para carga y análisis.

Son criterios iniciales, no SLA definitivos. Deben aprobarse para el ambiente.
