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
# editar .env con valores propios (no usar los de ejemplo en producción)
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

Para correr tests desde el host (fuera de Docker), se requieren **tres** variables de entorno:

- `DATABASE_URL`: conexión a PostgreSQL (ej: `postgresql://medibox:change-me@localhost:5433/medibox`)
- `SESSION_SECRET`: clave para sesiones
- `PACIENTE_ENCRYPTION_KEY`: clave de cifrado para datos sensibles de pacientes (es fácil olvidarla y los tests de Paciente fallarán sin ella)

Ejemplo:
```bash
export DATABASE_URL="postgresql://medibox:change-me@localhost:5433/medibox"
export SESSION_SECRET="test-secret"
export PACIENTE_ENCRYPTION_KEY="test-key"
npm test
```

### Usuario admin de desarrollo

Tras ejecutar `npm run seed`, se crea un usuario admin de desarrollo:
- Email: `admin@medibox.local`
- Contraseña: `Admin123!`

**⚠️ Cambiar estas credenciales antes de cualquier uso real.**

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
