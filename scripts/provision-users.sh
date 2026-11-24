#!/usr/bin/env bash
set -euo pipefail

# Aprovisiona cuentas de rendimiento en Keycloak y genera el pool privado k6.
# Es idempotente: crea usuarios inexistentes y actualiza los ya aprovisionados.

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

if [ -t 0 ] && [ -z "${TEST_CONFIG_FILE:-}" ]; then
  read -r -p \
    "Ruta del archivo de configuración [config/local.env]: " \
    TEST_CONFIG_FILE
fi

TEST_CONFIG_FILE=${TEST_CONFIG_FILE:-config/local.env}

if [ ! -f "$TEST_CONFIG_FILE" ]; then
  echo "Error: no existe $TEST_CONFIG_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$TEST_CONFIG_FILE"
set +a

ENV_NAME=${TEST_ENV_NAME:-$(basename "$TEST_CONFIG_FILE" .env)}
USER_PREFIX=${USER_PREFIX:-geosuite-perf}
REALM=${KEYCLOAK_REALM:?KEYCLOAK_REALM falta en el archivo de configuración}
EXEC_MODE=${KEYCLOAK_ADMIN_MODE:?KEYCLOAK_ADMIN_MODE falta en el archivo de configuración}
KC_SERVER=${KEYCLOAK_ADMIN_URL:?KEYCLOAK_ADMIN_URL falta en el archivo de configuración}
ADMIN_USER=${KC_ADMIN_USERNAME:?KC_ADMIN_USERNAME falta en el archivo de configuración}
ADMIN_REALM=${KC_ADMIN_REALM:?KC_ADMIN_REALM falta en el archivo de configuración}
KEYCLOAK_SERVICE=${KEYCLOAK_DOCKER_SERVICE:-keycloak}

if [ -t 0 ] && [ -z "${USER_COUNT:-}" ]; then
  read -r -p "¿Cuántos usuarios de prueba deseas crear?: " USER_COUNT
else
  USER_COUNT=${USER_COUNT:?USER_COUNT es obligatorio sin terminal interactiva}
fi

if ! [[ "$USER_COUNT" =~ ^[1-9][0-9]*$ ]]; then
  echo "Error: la cantidad debe ser un entero mayor que cero" >&2
  exit 1
fi

if ! [[ "$ENV_NAME" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "Error: nombre de ambiente no válido" >&2
  exit 1
fi

if ! [[ "$USER_PREFIX" =~ ^[a-zA-Z0-9._-]+$ ]]; then
  echo "Error: prefijo de usuarios no válido" >&2
  exit 1
fi

OUTPUT_FILE="config/users.${ENV_NAME}.json"
ENV_FILE="$TEST_CONFIG_FILE"

if [ "$EXEC_MODE" = "docker" ]; then
  kc() {
    docker compose exec -T "$KEYCLOAK_SERVICE" \
      /opt/keycloak/bin/kcadm.sh "$@"
  }
elif [ "$EXEC_MODE" = "local" ]; then
  KCADM_BIN=${KCADM_BIN:-kcadm.sh}
  command -v "$KCADM_BIN" >/dev/null 2>&1 || {
    echo "Error: no se encontró $KCADM_BIN" >&2
    exit 1
  }

  kc() {
    "$KCADM_BIN" "$@"
  }
else
  echo "Error: KEYCLOAK_ADMIN_MODE debe ser docker o local" >&2
  exit 1
fi

if [ -z "${KC_ADMIN_PASSWORD:-}" ]; then
  read -r -s -p "Contraseña administrativa de Keycloak: " KC_ADMIN_PASSWORD
  printf '\n'
fi

if [ -z "$KC_ADMIN_PASSWORD" ]; then
  echo "Error: la contraseña administrativa es obligatoria" >&2
  exit 1
fi

echo
echo "Ambiente: $ENV_NAME"
echo "Realm: $REALM"
echo "Servidor Keycloak: $KC_SERVER"
echo "Administrador: $ADMIN_USER ($ADMIN_REALM)"
echo "Usuarios: $USER_COUNT"
echo "Prefijo: $USER_PREFIX"
echo "Archivo privado: $OUTPUT_FILE"

kc config credentials \
  --server "$KC_SERVER" \
  --realm "$ADMIN_REALM" \
  --user "$ADMIN_USER" \
  --password "$KC_ADMIN_PASSWORD" \
  --client admin-cli >/dev/null

kc get "realms/$REALM" >/dev/null

TMP_USERS=$(mktemp)
trap 'rm -f "$TMP_USERS"; unset KC_ADMIN_PASSWORD' EXIT
chmod 600 "$TMP_USERS"

for ((index = 1; index <= USER_COUNT; index += 1)); do
  suffix=$(printf '%03d' "$index")
  username="${USER_PREFIX}-${suffix}"
  email="${username}@performance.invalid"
  first_name=GeoSuite
  last_name="Performance ${suffix}"
  password=$(openssl rand -hex 18)

  user_record=$(
    kc get users \
      -r "$REALM" \
      -q "email=$email" 2>/dev/null |
      python3 -c '
import json
import sys

expected = sys.argv[1].casefold()
users = json.load(sys.stdin)

for user in users:
    if str(user.get("email", "")).casefold() == expected:
        print(user.get("id", ""), user.get("username", ""), sep="\t")
        break
' "$email"
  )

  user_id=${user_record%%$'\t'*}
  login_name=${user_record#*$'\t'}

  if [ "$login_name" = "$user_record" ]; then
    login_name=
  fi

  if [ -z "$user_id" ]; then
    user_id=$(
      kc create users \
        -r "$REALM" \
        -s "username=$username" \
        -s "email=$email" \
        -s "firstName=$first_name" \
        -s "lastName=$last_name" \
        -s enabled=true \
        -s emailVerified=true \
        -i
    )
    action="creado"

    login_name=$(
      kc get "users/$user_id" \
        -r "$REALM" \
        --fields username \
        --format csv 2>/dev/null |
        tail -n 1 |
        tr -d '"\r'
    )
  else
    kc update "users/$user_id" \
      -r "$REALM" \
      -s "email=$email" \
      -s "firstName=$first_name" \
      -s "lastName=$last_name" \
      -s enabled=true \
      -s emailVerified=true >/dev/null
    action="actualizado"
  fi

  kc set-password \
    -r "$REALM" \
    --userid "$user_id" \
    --new-password "$password" \
    --temporary=false >/dev/null

  if [ -z "$login_name" ]; then
    echo "Error: Keycloak no devolvió el login de $email" >&2
    exit 1
  fi

  printf '%s\t%s\n' "$login_name" "$password" >> "$TMP_USERS"
  echo "$login_name: $action"
done

python3 - "$TMP_USERS" "$OUTPUT_FILE" <<'PY'
import json
import os
import sys
from pathlib import Path

source = Path(sys.argv[1])
target = Path(sys.argv[2])
users = []

for line in source.read_text(encoding="utf-8").splitlines():
    username, password = line.split("\t", 1)
    users.append({"username": username, "password": password})

target.parent.mkdir(parents=True, exist_ok=True)
temporary = target.with_suffix(target.suffix + ".tmp")
temporary.write_text(
    json.dumps(users, indent=2, ensure_ascii=False) + "\n",
    encoding="utf-8",
)
os.chmod(temporary, 0o600)
temporary.replace(target)
os.chmod(target, 0o600)
PY

if [ -f "$ENV_FILE" ]; then
  python3 - "$ENV_FILE" "../config/users.${ENV_NAME}.json" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
value = sys.argv[2]
lines = path.read_text(encoding="utf-8").splitlines()
key = "AUTH_USERS_FILE="
replacement = key + value

for index, line in enumerate(lines):
    if line.startswith(key):
        lines[index] = replacement
        break
else:
    lines.extend(["", "# Pool privado asignado automáticamente por VU.", replacement])

path.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY
  chmod 600 "$ENV_FILE"
  echo "AUTH_USERS_FILE actualizado en $ENV_FILE"
else
  echo "Aviso: no existe $ENV_FILE; configura AUTH_USERS_FILE manualmente"
fi

echo
echo "Pool creado correctamente: $OUTPUT_FILE"
echo "Permisos: $(stat -c '%a' "$OUTPUT_FILE")"
echo "Las contraseñas no se muestran y el archivo está excluido de Git."
