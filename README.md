# MediBox

Sistema de gestión de espacios clínicos y agenda médica, autoalojado
(sin dependencias de nube), construido como proyecto académico para
un ramo de Seguridad y Protección de Datos.

## Requisitos

- Docker y Docker Compose
- Node.js 20+ (para desarrollo local fuera de Docker)

## Levantar el proyecto

```bash
cp .env.example .env
# editar .env con valores propios (no usar los de ejemplo en producción);
# las llaves de cifrado se generan como indica el propio .env.example
docker compose up --build
```

La app queda disponible en `http://localhost:3000`, que redirige al
formulario de login (`/auth/login-form`). Endpoint de salud: `GET /health`.

## Desarrollo

### Setup

```bash
cd app
npm install
```

### Comandos disponibles

```bash
npm run dev        # servidor con recarga automática
npm run lint        # ESLint
npm test            # suite completa (requiere Postgres corriendo)
npm run test:unit
npm run test:integration
npm run seed         # datos de catálogo + usuario admin de desarrollo
```

Procesos de operación (pensados para el cron del servidor o para un
incidente; dentro de Docker se corren con `docker compose exec -T app ...`):

```bash
npm run retencion              # plazos de conservación (diario)
npm run recordatorios          # recordatorios de citas, solo con consentimiento vigente (diario)
npm run alertas                # reglas de accesos anómalos; avisa a los gestores (diario u horario)
npm run supresiones:reaplicar  # vuelve a aplicar las supresiones (lo corre ops/restaurar-db.sh)
npm run incidente:alcance -- --desde AAAA-MM-DD --hasta AAAA-MM-DD [--usuario N] [--ids]
npm run llaves:rotar -- --variable PACIENTE_IDENTIDAD_KEY   # ver "Rotación de llaves"
npm run sesiones:cerrar -- --correo cuenta@dominio          # cierra todas las sesiones de una cuenta comprometida
```

### Variables de entorno para tests locales

Los tests cargan el `.env` de la raíz (ver `tests/setup-env.js`), así que
`SESSION_SECRET` y las llaves `PACIENTE_*_KEY` salen de ahí. Desde el host
(fuera de Docker) solo hay que apuntar `DATABASE_URL` al puerto publicado:

```bash
export DATABASE_URL="postgresql://medibox:change-me@localhost:5433/medibox"
npm test
```

### Usuario admin de desarrollo

Tras ejecutar `npm run seed`, se crea un usuario admin de desarrollo:
- Email: `admin@medibox.local`
- Contraseña: `Admin123!`

**⚠️ Cambiar estas credenciales antes de cualquier uso real.**

## Cifrado de datos de pacientes

Nombre, RUT, fecha de nacimiento, contacto y motivo de consulta se cifran en
la aplicación con AES-256-GCM (`app/src/lib/cifrado.js`) antes de llegar a PostgreSQL; la base
solo guarda blobs cifrados y nunca recibe las llaves. Cada categoría tiene su
propia llave:

| Variable | Protege |
|---|---|
| `PACIENTE_IDENTIDAD_KEY` | nombre, RUT y fecha de nacimiento |
| `PACIENTE_CONTACTO_KEY` | teléfono / correo |
| `PACIENTE_CLINICO_KEY` | motivo de consulta |
| `PACIENTE_RUT_HMAC_KEY` | índice ciego del RUT (HMAC-SHA256): búsqueda exacta y unicidad sin descifrar |
| `PACIENTE_SEUDONIMO_KEY` | seudónimo del paciente en los CSV exportados (HMAC-SHA256): quien la tenga, junto con la base, puede volver a identificarlo |
| `AUDITORIA_HMAC_KEY` | HMAC del correo de un inicio de sesión fallido en la auditoría: cuenta los intentos sobre una cuenta sin guardar el correo |

Las mismas llaves protegen lo que agregó el Hito 3, cada valor con su propio
AAD: el valor anterior de un dato rectificado (historial), el valor propuesto
en una solicitud de rectificación, la respuesta al titular y los datos del
representante de un menor.

Las exportaciones de `/datos` nunca identifican a un paciente: el CSV de
pacientes es un reporte seudonimizado (seudónimo, tramo de edad, año de
registro y número de citas) y los de citas y auditoría lo nombran por el
mismo seudónimo. Al agregar `PACIENTE_SEUDONIMO_KEY` a un `.env` existente,
genérala como las demás llaves.

Perder una llave significa perder los datos que protege: deben respaldarse
fuera del servidor y separadas de los respaldos de la base.

El servidor revisa la configuración al arrancar (`app/src/lib/entorno.js`) y
se niega a iniciar si falta una llave, si no mide 32 bytes, si dos variables
comparten la misma llave, si `SESSION_SECRET` es corto o conserva el valor de
ejemplo, o si en producción la base usa la contraseña de `.env.example`.

### Rotación de llaves

Si una llave se filtra, `npm run llaves:rotar` recifra todo lo que protege
(o recalcula el índice del RUT) en una sola transacción: si cualquier valor
no se descifra con la llave anterior, no cambia nada. Con la app detenida:

```bash
docker compose stop app
MEDIBOX_RESPALDO_CLAVE=~/medibox-respaldo.clave ops/respaldar-db.sh
# En .env: la llave actual pasa a PACIENTE_IDENTIDAD_KEY_ANTERIOR y la nueva
# (generada como las demás) queda en PACIENTE_IDENTIDAD_KEY.
docker compose run --rm app npm run llaves:rotar -- --variable PACIENTE_IDENTIDAD_KEY
# Borra PACIENTE_IDENTIDAD_KEY_ANTERIOR del .env y vuelve a levantar la app.
docker compose up -d
```

Se pueden rotar `PACIENTE_IDENTIDAD_KEY`, `PACIENTE_CONTACTO_KEY`,
`PACIENTE_CLINICO_KEY` y `PACIENTE_RUT_HMAC_KEY`. `PACIENTE_SEUDONIMO_KEY` no
se guarda en ninguna columna: cambiarla solo rompe la continuidad de los
seudónimos ya exportados. `AUDITORIA_HMAC_KEY` tampoco se recifra (la
auditoría es de solo inserción): con una nueva, los intentos fallidos se
cuentan desde cero.

### Migrar una base existente

Las bases creadas antes de este cambio guardan el nombre y el contacto en
texto plano, y el RUT y el motivo cifrados con pgcrypto. La migración tiene
dos pasos y entre ellos hay que recifrar los datos:

```bash
# 1. Aplica el paso 1 (expandir). El paso 2 se detiene a propósito con
#    "Hay pacientes sin migrar..." mientras queden datos sin recifrar.
npx prisma migrate deploy

# 2. Recifra los pacientes. Necesita la llave anterior en
#    PACIENTE_ENCRYPTION_KEY y las cuatro llaves nuevas.
npm run cifrado:migrar

# 3. Marca el paso 2 como revertido y vuelve a aplicarlo.
npx prisma migrate resolve --rolled-back 20261001160100_cifrado_pacientes_contraer
npx prisma migrate deploy
```

Con Docker, cada comando se ejecuta dentro del contenedor de la app, por
ejemplo `docker compose run --rm app npm run cifrado:migrar`. Una base nueva
(o la de CI) aplica ambos pasos de corrido, sin intervención.

### Minimización de datos del paciente

El motivo de consulta pasó del paciente a cada cita
(`20261003180000_motivo_en_citas_expandir`), la fecha de nacimiento se cifra
y el contacto es opcional (`20261016120000_minimizacion_pacientes_expandir`).
El paso `20261016120100_minimizacion_pacientes_contraer` elimina la fecha en
claro y el motivo de legado del paciente, y se detiene a propósito mientras
queden datos sin migrar. En una base que ya tiene pacientes:

```bash
# 1. Aplica los pasos "expandir"; el paso "contraer" se detiene.
docker compose exec app npx prisma migrate deploy

# 2. Copia el motivo de legado a las citas y cifra las fechas de nacimiento.
docker compose exec app npm run minimizacion:migrar

# 3. Marca el paso "contraer" como revertido y vuelve a aplicarlo.
docker compose exec app npx prisma migrate resolve --rolled-back 20261016120100_minimizacion_pacientes_contraer
docker compose exec app npx prisma migrate deploy
```

El script es idempotente y no borra nada. El paso "contraer" descarta el
motivo de legado de los pacientes que no tienen ninguna cita: no orienta
ninguna atención. Una base nueva aplica todo de corrido, sin intervención.

## Respaldos cifrados

`ops/respaldar-db.sh` vuelca la base con `pg_dump` y la cifra con gpg
(AES-256, modo simétrico) en el mismo pipe, sin escribir nunca el volcado en
claro. `ops/restaurar-db.sh` primero verifica el archivo completo (gpg rechaza
una frase de paso incorrecta o un archivo alterado) y luego restaura en una
sola transacción. Ambos requieren `gpg` y la base levantada con Docker Compose.

```bash
# La frase de paso vive en un archivo fuera del repositorio y separado de
# los respaldos (por ejemplo, en el gestor de secretos del equipo).
openssl rand -base64 32 > ~/medibox-respaldo.clave

MEDIBOX_RESPALDO_CLAVE=~/medibox-respaldo.clave ops/respaldar-db.sh
MEDIBOX_RESPALDO_CLAVE=~/medibox-respaldo.clave ops/restaurar-db.sh respaldos/medibox-AAAAMMDD-HHMMSS.dump.gpg --confirmar
```

Un respaldo solo sirve si se puede restaurar: conviene probar la
restauración periódicamente, no solo generar los archivos.

Cada respaldo exitoso elimina los anteriores con más de 30 días
(`MEDIBOX_RESPALDO_DIAS` cambia el plazo). Solo toca archivos
`medibox-*.dump.gpg` del directorio de destino.

## Plazos de conservación

| Dato | Plazo | Cómo se aplica |
|---|---|---|
| Pacientes, citas y auditoría | al menos 15 años (Ley 20.584, art. 13) | no se eliminan; la auditoría es de solo inserción (un trigger rechaza UPDATE, DELETE y TRUNCATE) |
| Historial de cambios, consentimientos y solicitudes de derechos | igual que la ficha | no se eliminan: son la prueba de lo que pidió el titular |
| Paciente bloqueado (bloqueo o supresión) | igual que la ficha | se conserva sin usarse; la supresión elimina de verdad el contacto, los consentimientos y al representante |
| Códigos de verificación y del portal | 10 minutos, un solo uso | solo se guarda su hash; `npm run retencion` borra el hash y la sal al día siguiente (la fila queda como respaldo de lo que verificó) |
| Lista de supresiones (`registro/supresiones.jsonl`) | mientras existan respaldos anteriores a la supresión | fuera de la base; `ops/restaurar-db.sh` la reaplica |
| Contacto del paciente | 2 años sin citas | `npm run retencion` lo elimina |
| Notificaciones | 1 año | `npm run retencion` las elimina |
| Sesiones | 8 horas (las del portal del paciente, 15 minutos) | vencen solas; `npm run sesiones:cerrar` cierra las de una cuenta |
| Respaldos | 30 días | `ops/respaldar-db.sh` rota los anteriores |
| Logs de los contenedores | 3 archivos de 10 MB | rotación de Docker (`docker-compose.yml`) |

`npm run retencion` es idempotente y está pensado para el cron diario del
servidor:

```bash
docker compose exec -T app npm run retencion
```

## Consentimiento, derechos del titular e incidentes (Hito 3)

Las peticiones del titular llegan por cualquier canal (en admisión, por
teléfono o por correo) y un funcionario las registra, indicando el canal; o
las hace el propio titular en el **portal del paciente** (ver más abajo).

- **Consentimiento por finalidad** (`/pacientes/:id`, operador): solo para
  usos opcionales (recordatorios, investigación y encuestas). La atención no
  depende de él. Cada otorgamiento guarda la versión del texto, el canal, quién
  lo registró y la verificación de identidad; revocar sigue el mismo
  procedimiento y no borra nada. Los menores de 14 consienten por medio de su
  representante, cuyos datos se guardan cifrados.
- **Verificación de identidad**: con la cédula en admisión (base) o con un
  código de un solo uso enviado al contacto ya registrado (complemento). En
  desarrollo el envío se simula en `registro/buzon-simulado.txt` (los últimos
  50 mensajes); en producción va por el correo del hospital con
  `CANAL_ENVIO=smtp` y las variables `SMTP_*` de `.env.example` (solo a
  correos, con TLS; sin SMTP, se usa la cédula). Supresión y bloqueo solo se
  aceptan con cédula, y los ejecuta una persona distinta de quien verificó.
- **Derechos ARCO+**: el operador recibe y verifica las solicitudes desde la
  ficha; el rol `privacidad` (usuario demo `privacidad@medibox.local`) las
  resuelve en `/solicitudes`. Acceso y portabilidad generan un JSON del
  titular, con reautenticación del funcionario, entregado en persona o al
  contacto registrado.
- **Auditoría y alertas**: la auditoría registra actor (`usuario`, `sistema`,
  `titular` o `portal`), resultado e IP sin datos personales; `/alertas`
  (gestor) aplica las reglas de monitoreo, incluidas un inicio de sesión desde
  una IP que la cuenta no usaba y el abuso del portal.
- **Política de tratamiento**: pública en `/privacidad`.

### Portal del paciente (`/portal`)

Acceso temporal, sin cuentas ni contraseñas: el titular escribe su RUT y
recibe un código de un solo uso en el contacto que ya tenía registrado (si
lleva 24 horas sin cambiar). Con el código abre una sesión de 15 minutos,
atada a su propio registro, para:

- ver sus datos, sus citas y quién accedió a ellos (por función);
- descargar todos sus datos en JSON (acceso y portabilidad);
- aceptar o revocar los usos opcionales con un clic (un menor de 14, por
  medio de su representante);
- pedir una rectificación (la revisa y aplica privacidad), una supresión o
  un bloqueo (quedan pendientes de la cédula en admisión).

Controles: la respuesta a un RUT es la misma exista o no; 5 intentos por
código, 3 códigos por paciente por hora y límites por IP; ninguna ruta recibe
el id de un paciente; la sesión se regenera al ingresar y no abre ninguna
ruta del personal; un paciente bloqueado no entra. Todo queda en la
auditoría con actor `titular`. En desarrollo el código aparece en
`registro/buzon-simulado.txt`.

La IP de la auditoría es `req.ip`. Si se pone un proxy inverso con TLS
delante, hay que definir `TRUST_PROXY` (ver `.env.example`) para que la IP
registrada sea la del cliente y no la del proxy.

## Notas técnicas

- El `docker-compose.yml` local remapea el puerto 5432 del contenedor al 5433 del host (solo en esta máquina de desarrollo). En CI/CD (GitHub Actions), Postgres usa el puerto 5432 estándar sin remap.
- La base de datos se inicia automáticamente cuando se levanta `docker compose up`.
- Todos los tests requieren una instancia de Postgres activa (ya sea via Docker Compose o servicio local).

### Cobertura de tests: estado real (honesto)

`jest.config.js` define un `coverageThreshold` de 70% (branches/functions/lines/statements)
sobre `src/services/**/*.js`, y existe el script `npm run test:coverage`. **Esto no se
verifica de forma automatizada en ningún punto del proyecto actualmente**:

- `npm run test:coverage` solo corre `jest tests/unit --coverage`, es decir, únicamente
  los tests unitarios. De los 11 archivos en `src/services/`, solo 4 tienen un test
  unitario dedicado (`auditService`, `authService`, `citaService`, `rbacService`); los
  otros 7 servicios (`especialidadService`, `medicoService`, `espacioService`,
  `pacienteService`, `notificacionService`, entre otros) no tienen ningún test unitario
  propio, por lo que su cobertura medida por `test:coverage` es 0% aunque su lógica sí
  está ejercitada — pero por tests de **integración**, no unitarios.
- El pipeline de CI (GitHub Actions) corre `npm test` (la suite completa, unit +
  integración) pero nunca con la flag `--coverage`, así que el `coverageThreshold`
  configurado en `jest.config.js` nunca se evalúa como parte de CI. Un cambio que
  bajara la cobertura real no haría fallar ningún build.
- En otras palabras: el umbral de 70% está declarado en la configuración pero no tiene
  ningún efecto práctico hoy — no bloquea commits, PRs, ni el pipeline. Gran parte de la
  lógica de negocio (services) se valida mediante tests de integración contra una base
  de datos Postgres real (ver `tests/integration/`), lo cual da confianza funcional real,
  pero es una métrica distinta a la cobertura de línea/rama que mide Jest sobre tests
  unitarios, y no puede usarse para aproximarla.
- Cerrar esta brecha correctamente requeriría (a) agregar tests unitarios a los 7
  servicios sin cobertura propia y/o (b) correr `test:coverage` sobre `tests/integration`
  también (o combinar ambos con `--coverage` y `collectCoverageFrom` ajustado) e incorporar
  ese paso al workflow de CI. Ninguna de las dos cosas está hecha; queda como trabajo
  pendiente explícito, no como un descuido silencioso.
