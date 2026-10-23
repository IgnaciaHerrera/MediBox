const path = require('path');
const express = require('express');
const helmet = require('helmet');
const pinoHttp = require('pino-http');
const { logger, serializadoresHttp } = require('./lib/logger');
const { errorHandler } = require('./middleware/errorHandler');
const { sessionMiddleware } = require('./middleware/session');
const contexto = require('./lib/contexto');
const { issueCsrfToken, verifyCsrf } = require('./middleware/csrf');
const { requireAuth } = require('./middleware/requireAuth');
const { attachUsuario } = require('./middleware/attachUsuario');
const { dashboard } = require('./controllers/viewController');
const { isoLocal, fechaDMA } = require('./lib/fecha');
const { pasarToastAVista } = require('./lib/toast');
const { TRATAMIENTO } = require('./lib/tratamiento');
const authRoutes = require('./routes/auth');
const agendaViewRoutes = require('./routes/agendaViews');
const pacienteViewRoutes = require('./routes/pacienteViews');
const espacioViewRoutes = require('./routes/espacioViews');
const medicoViewRoutes = require('./routes/medicoViews');
const notificacionViewRoutes = require('./routes/notificacionViews');
const auditoriaViewRoutes = require('./routes/auditoriaViews');
const usuarioViewRoutes = require('./routes/usuarioViews');
const rolViewRoutes = require('./routes/rolViews');
const datosViewRoutes = require('./routes/datosViews');
const especialidadRoutes = require('./routes/especialidades');
const medicoRoutes = require('./routes/medicos');
const espacioRoutes = require('./routes/espacios');
const auditoriaRoutes = require('./routes/auditoria');
const pacienteRoutes = require('./routes/pacientes');
const citaRoutes = require('./routes/citas');
const notificacionRoutes = require('./routes/notificaciones');
const usuarioRoutes = require('./routes/usuarios');
const rolRoutes = require('./routes/roles');
const verificacionRoutes = require('./routes/verificacion');
const solicitudViewRoutes = require('./routes/solicitudViews');
const alertaViewRoutes = require('./routes/alertaViews');
const portalRoutes = require('./routes/portal');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Disponible en todas las vistas: fechas ISO como día-mes-año (lib/fecha.js).
app.locals.fechaDMA = fechaDMA;
// Marcas de tiempo (createdAt, timestamp) en hora local: "2026-10-03 14:05:09".
app.locals.isoLocal = isoLocal;

// Solo con un proxy inverso con TLS delante: TRUST_PROXY nombra el proxy de
// confianza (p. ej. "loopback" o su IP; un número es la cantidad de saltos).
// Así req.ip, que va a la auditoría, es la del cliente y no la del proxy, y
// nadie más puede falsificarla con X-Forwarded-For.
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
}

app.use(helmet());
// Las fuentes casi no cambian: el navegador las guarda un mes.
app.use('/fonts', express.static(path.join(__dirname, 'public', 'fonts'), { maxAge: '30d' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(pinoHttp({ logger, serializers: serializadoresHttp }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);
// Después de la sesión: el contexto (la IP para la auditoría) debe abrirse
// una vez cargada, para que su callback no lo pierda.
app.use(contexto.middleware);
app.use(issueCsrfToken);
app.use(pasarToastAVista);

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true });
});

// Página de inicio pública. El paciente empieza a ingresar ahí mismo (el
// formulario envía a /portal/ingresar); con una sesión del portal vigente se
// le ofrece volver a sus datos en vez de pedirle otro código. El personal
// entra por /auth/login-form.
app.get('/', (req, res) => {
  const portalActivo = Boolean(req.session.portal && req.session.portal.expiraEl > Date.now());
  res.render('landing', { titulo: 'Inicio', portalActivo, csrfToken: res.locals.csrfToken });
});

// Política de tratamiento de datos (Ley 21.719, art. 14 ter): pública.
app.get('/privacidad', (req, res) => res.render('privacidad', { titulo: 'Política de privacidad', tratamiento: TRATAMIENTO }));

// Protección CSRF de doble envío para toda mutación de la aplicación (API y
// vistas por igual), sin importar el orden en que se monten los routers
// individuales debajo ni si alguno olvida aplicarlo por su cuenta — este es
// justo el tipo de hueco que se encontró y cerró en la revisión final.
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  return verifyCsrf(req, res, next);
});

// Feature routes are mounted here by later tasks.
app.use('/auth', authRoutes);
app.get('/dashboard', requireAuth, attachUsuario, dashboard);
app.use('/agenda', agendaViewRoutes);
app.use('/pacientes', pacienteViewRoutes);
app.use('/espacios', espacioViewRoutes);
app.use('/medicos', medicoViewRoutes);
app.use('/notificaciones', notificacionViewRoutes);
app.use('/auditoria', auditoriaViewRoutes);
app.use('/usuarios', usuarioViewRoutes);
app.use('/roles', rolViewRoutes);
app.use('/datos', datosViewRoutes);
app.use('/verificacion', verificacionRoutes);
app.use('/solicitudes', solicitudViewRoutes);
app.use('/alertas', alertaViewRoutes);
// Portal temporal del titular: público, con su propia sesión (sin usuarioId).
app.use('/portal', portalRoutes);
app.use('/api/especialidades', especialidadRoutes);
app.use('/api/medicos', medicoRoutes);
app.use('/api', espacioRoutes);
app.use('/api/auditoria', auditoriaRoutes);
app.use('/api/pacientes', pacienteRoutes);
app.use('/api/citas', citaRoutes);
app.use('/api/notificaciones', notificacionRoutes);
app.use('/api/usuarios', usuarioRoutes);
app.use('/api/roles', rolRoutes);

app.use(errorHandler);

module.exports = app;
