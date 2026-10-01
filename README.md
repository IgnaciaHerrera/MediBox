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

La app queda disponible en `http://localhost:3000`. Endpoint de salud: `GET /health`.

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

Nombre, RUT, contacto y motivo de consulta se cifran en la aplicación con
AES-256-GCM (`app/src/lib/cifrado.js`) antes de llegar a PostgreSQL; la base
solo guarda blobs cifrados y nunca recibe las llaves. Cada categoría tiene su
propia llave:

| Variable | Protege |
|---|---|
| `PACIENTE_IDENTIDAD_KEY` | nombre y RUT |
| `PACIENTE_CONTACTO_KEY` | teléfono / correo |
| `PACIENTE_CLINICO_KEY` | motivo de consulta |
| `PACIENTE_RUT_HMAC_KEY` | índice ciego del RUT (HMAC-SHA256): búsqueda exacta y unicidad sin descifrar |

Perder una llave significa perder los datos que protege: deben respaldarse
fuera del servidor y separadas de los respaldos de la base.

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

## Documentación de diseño

- [Spec de diseño](docs/superpowers/specs/2026-09-11-medibox-design.md)
- [Plan de implementación](docs/superpowers/plans/2026-09-11-medibox-implementation.md)
