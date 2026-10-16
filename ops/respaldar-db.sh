#!/usr/bin/env bash
# Respaldo cifrado de la base de datos de MediBox.
#
# Vuelca la base con pg_dump desde el contenedor `db` y la cifra con gpg en
# modo simétrico (AES-256) en el mismo pipe: el volcado en claro nunca se
# escribe a disco. La frase de paso se lee de un archivo que debe guardarse
# fuera del repositorio y separado de los respaldos (ver README).
#
# Después de un respaldo exitoso elimina los respaldos de este mismo script
# con más de MEDIBOX_RESPALDO_DIAS días (30 por omisión): el plazo de
# conservación de las copias de seguridad del inventario del Hito 1.
#
# Uso: MEDIBOX_RESPALDO_CLAVE=/ruta/a/frase ops/respaldar-db.sh [directorio]
set -euo pipefail

raiz="$(cd "$(dirname "$0")/.." && pwd)"
clave="${MEDIBOX_RESPALDO_CLAVE:?Define MEDIBOX_RESPALDO_CLAVE con la ruta al archivo de la frase de paso}"
destino="${1:-$raiz/respaldos}"
dias="${MEDIBOX_RESPALDO_DIAS:-30}"

if ! [[ "$dias" =~ ^[1-9][0-9]*$ ]]; then
  echo "MEDIBOX_RESPALDO_DIAS debe ser un número entero de días mayor que cero" >&2
  exit 1
fi

if [ ! -r "$clave" ]; then
  echo "No se puede leer el archivo de la frase de paso: $clave" >&2
  exit 1
fi

umask 077
mkdir -p "$destino"
archivo="$destino/medibox-$(date +%Y%m%d-%H%M%S).dump.gpg"

# Si pg_dump o gpg fallan, no se deja un respaldo a medias que parezca válido.
completo=""
trap '[ -n "$completo" ] || rm -f "$archivo"' EXIT

docker compose -f "$raiz/docker-compose.yml" exec -T db \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' |
  gpg --batch --yes --pinentry-mode loopback --passphrase-file "$clave" \
    --symmetric --cipher-algo AES256 --s2k-digest-algo SHA512 --s2k-count 65011712 \
    --output "$archivo"

completo=1
echo "Respaldo cifrado: $archivo"

# Solo archivos con el nombre que genera este script, directamente en el
# destino (sin bajar a subcarpetas), y solo después de un respaldo exitoso:
# nunca se queda sin la copia más reciente.
vencidos="$(find "$destino" -maxdepth 1 -type f -name 'medibox-*.dump.gpg' -mtime +"$dias" -print -delete | wc -l)"
echo "Respaldos con más de $dias días eliminados: $vencidos"
