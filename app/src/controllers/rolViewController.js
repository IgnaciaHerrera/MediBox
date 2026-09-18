const rolService = require('../services/rolService');
const { AppError } = require('../lib/AppError');

// Orden de "menor a mayor" privilegio, para que la matriz se lea como una
// progresión de acceso en vez del orden alfabético (que dejaría a `admin`
// primero por azar).
const ORDEN_ROLES = ['consulta', 'operador', 'medico', 'gestor', 'admin'];

const ORDEN_DOMINIOS = ['dashboard', 'agenda', 'box', 'medicos', 'paciente', 'notificaciones', 'auditoria', 'data', 'admin'];

const ETIQUETAS_DOMINIO = {
  dashboard: 'Panel principal',
  agenda: 'Agenda',
  box: 'Espacios',
  medicos: 'Médicos',
  paciente: 'Pacientes',
  notificaciones: 'Notificaciones',
  auditoria: 'Auditoría',
  data: 'Datos',
  admin: 'Administración',
};

const ETIQUETAS_PERMISO = {
  'dashboard.read': 'Ver panel principal',
  'dashboard.write': 'Editar panel principal',
  'agenda.read': 'Ver agenda',
  'agenda.write': 'Crear, editar y anular citas',
  'box.read': 'Ver espacios (pasillos y boxes)',
  'box.write': 'Crear, editar y eliminar espacios',
  'box.detalle.read': 'Ver detalle e instrumental de un box',
  'box.detalle.write': 'Editar instrumental de un box',
  'medicos.read': 'Ver médicos y especialidades',
  'paciente.read': 'Ver pacientes',
  'paciente.write': 'Crear y editar pacientes',
  'notificaciones.read': 'Ver notificaciones',
  'auditoria.read': 'Ver registro de auditoría',
  'data.import': 'Importar datos',
  'data.export': 'Exportar datos',
  'admin.users': 'Gestionar usuarios',
  'admin.roles': 'Gestionar roles y permisos',
  'admin.system': 'Configuración del sistema',
};

function ordenarRoles(roles) {
  return [...roles].sort((a, b) => ORDEN_ROLES.indexOf(a.nombre) - ORDEN_ROLES.indexOf(b.nombre));
}

// Agrupa la lista plana de permisos por dominio (el primer segmento de su
// clave, p. ej. "box" en "box.detalle.write"), en el orden fijo definido
// arriba, para que la matriz muestre secciones legibles en vez de una
// columna de claves técnicas sin estructura.
function agruparPermisos(permisosDisponibles) {
  const porDominio = new Map();
  permisosDisponibles.forEach((p) => {
    const dominio = p.clave.split('.')[0];
    if (!porDominio.has(dominio)) porDominio.set(dominio, []);
    porDominio.get(dominio).push({ clave: p.clave, etiqueta: ETIQUETAS_PERMISO[p.clave] || p.clave });
  });
  return ORDEN_DOMINIOS.filter((dominio) => porDominio.has(dominio)).map((dominio) => ({
    etiqueta: ETIQUETAS_DOMINIO[dominio] || dominio,
    permisos: porDominio.get(dominio),
  }));
}

async function cargarDatosVista() {
  const [roles, permisosDisponibles] = await Promise.all([rolService.listar(), rolService.listarPermisosDisponibles()]);
  const rolesConSet = ordenarRoles(roles).map((rol) => ({
    ...rol,
    clavesActivas: new Set(rol.permisos.map((rp) => rp.permiso.clave)),
  }));
  return { roles: rolesConSet, grupos: agruparPermisos(permisosDisponibles) };
}

async function index(req, res, next) {
  try {
    const { roles, grupos } = await cargarDatosVista();
    res.render('roles/index', {
      titulo: 'Roles y permisos',
      usuario: req.usuario,
      csrfToken: res.locals.csrfToken,
      roles,
      grupos,
      error: null,
    });
  } catch (err) {
    next(err);
  }
}

function normalizarLista(valor) {
  if (valor === undefined) return [];
  return Array.isArray(valor) ? valor : [valor];
}

// La matriz es un único formulario con una casilla por (rol, permiso); cada
// rol viaja como su propio campo `permisos_<rolId>` más un marcador
// `rolesEnviados` (así se distingue "el rol se envió sin ningún permiso
// marcado" de "el rol ni siquiera estaba en el formulario").
async function actualizarTodo(req, res, next) {
  try {
    const idsRoles = normalizarLista(req.body.rolesEnviados).map(Number);
    for (const rolId of idsRoles) {
      const permisos = normalizarLista(req.body[`permisos_${rolId}`]);
      // eslint-disable-next-line no-await-in-loop
      await rolService.actualizarPermisos(rolId, permisos);
    }

    if (req.accepts('html') && !req.is('json')) {
      return res.redirect('/roles');
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    if (err instanceof AppError) {
      if (req.accepts('html') && !req.is('json')) {
        const { roles, grupos } = await cargarDatosVista();
        return res.status(err.statusCode).render('roles/index', {
          titulo: 'Roles y permisos', usuario: req.usuario, csrfToken: res.locals.csrfToken, roles, grupos, error: err.message,
        });
      }
      return res.status(err.statusCode).json({ error: err.message });
    }
    return next(err);
  }
}

module.exports = { index, actualizarTodo };
