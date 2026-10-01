#!/usr/bin/env bash
# Restaura un respaldo creado con ops/respaldar-db.sh.
#
# REEMPLAZA el contenido actual de la base, por eso exige --confirmar.
# Primero descifra el archivo completo solo para verificarlo: gpg comprueba
# su integridad (MDC) y falla si la frase de paso no corresponde o el archivo
# fue alterado. Recién entonces lo vuelve a descifrar hacia pg_restore, que
# aplica todo en una sola transacción: si algo falla, la base queda como
# estaba. En ningún momento se escribe el volcado en claro a disco.
#
# Uso: MEDIBOX_RESPALDO_CLAVE=/ruta/a/frase ops/restaurar-db.sh <archivo.dump.gpg> --confirmar
set -euo pipefail

raiz="$(cd "$(dirname "$0")/.." && pwd)"
clave="${MEDIBOX_RESPALDO_CLAVE:?Define MEDIBOX_RESPALDO_CLAVE con la ruta al archivo de la frase de paso}"
archivo="${1:?Indica el archivo de respaldo a restaurar}"

if [ "${2:-}" != "--confirmar" ]; then
  echo "Esto reemplaza la base actual con $archivo. Repite el comando agregando --confirmar." >&2
  exit 1
fi

descifrar() {
  gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$clave" --decrypt "$archivo"
}

descifrar > /dev/null
echo "Respaldo verificado: se descifra completo y su integridad es correcta."

descifrar | docker compose -f "$raiz/docker-compose.yml" exec -T db \
  sh -c 'pg_restore --clean --if-exists --no-owner --single-transaction -U "$POSTGRES_USER" -d "$POSTGRES_DB"'

echo "Base restaurada desde $archivo"
