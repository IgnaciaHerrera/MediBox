const path = require('path');
const express = require('express');
const helmet = require('helmet');
const pinoHttp = require('pino-http');
const { logger, serializadoresHttp } = require('./lib/logger');
const { errorHandler } = require('./middleware/errorHandler');
const { sessionMiddleware } = require('./middleware/session');
const { issueCsrfToken, verifyCsrf } = require('./middleware/csrf');
const { requireAuth } = require('./middleware/requireAuth');
const { attachUsuario } = require('./middleware/attachUsuario');
const { dashboard } = require('./controllers/viewController');
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

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(helmet());
app.use(express.static(path.join(__dirname, 'public')));
app.use(pinoHttp({ logger, serializers: serializadoresHttp }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);
app.use(issueCsrfToken);

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true });
});

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
