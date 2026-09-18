const path = require('path');
const express = require('express');
const helmet = require('helmet');
const pinoHttp = require('pino-http');
const { logger } = require('./lib/logger');
const { errorHandler } = require('./middleware/errorHandler');
const { sessionMiddleware } = require('./middleware/session');
const { issueCsrfToken, verifyCsrf } = require('./middleware/csrf');
const { requireAuth } = require('./middleware/requireAuth');
const { attachUsuario } = require('./middleware/attachUsuario');
const { dashboard } = require('./controllers/viewController');
const authRoutes = require('./routes/auth');
const especialidadRoutes = require('./routes/especialidades');
const medicoRoutes = require('./routes/medicos');
const espacioRoutes = require('./routes/espacios');
const auditoriaRoutes = require('./routes/auditoria');
const pacienteRoutes = require('./routes/pacientes');
const citaRoutes = require('./routes/citas');
const notificacionRoutes = require('./routes/notificaciones');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(helmet());
app.use(pinoHttp({ logger }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);
app.use(issueCsrfToken);

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true });
});

// Protección CSRF de doble envío para toda mutación bajo /api, sin importar
// el orden en que se monten los routers de recursos individuales debajo.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  return verifyCsrf(req, res, next);
});

// Feature routes are mounted here by later tasks.
app.use('/auth', authRoutes);
app.get('/dashboard', requireAuth, attachUsuario, dashboard);
app.use('/api/especialidades', especialidadRoutes);
app.use('/api/medicos', medicoRoutes);
app.use('/api', espacioRoutes);
app.use('/api/auditoria', auditoriaRoutes);
app.use('/api/pacientes', pacienteRoutes);
app.use('/api/citas', citaRoutes);
app.use('/api/notificaciones', notificacionRoutes);

app.use(errorHandler);

module.exports = app;
