const citaService = require('../services/citaService');
const pacienteService = require('../services/pacienteService');
const notificacionService = require('../services/notificacionService');
const usuarioService = require('../services/usuarioService');
const medicoService = require('../services/medicoService');
const { hoyISO } = require('../lib/fecha');

const DOMINIOS = {
  dashboard: 'Panel',
  agenda: 'Agenda',
  box: 'Espacios',
  medicos: 'Médicos',
  paciente: 'Pacientes',
  notificaciones: 'Notificaciones',
  auditoria: 'Auditoría',
  data: 'Datos',
  admin: 'Administración',
};

const ACCIONES = {
  read: 'ver',
  write: 'gestionar',
  'detalle.read': 'ver detalle',
  'detalle.write': 'gestionar detalle',
  historial: 'ver historial',
  import: 'importar',
  export: 'exportar',
  users: 'usuarios',
  roles: 'roles',
  system: 'sistema',
};

function agruparAccesos(permisos) {
  const grupos = new Map();

  permisos.forEach((permiso) => {
    const separador = permiso.indexOf('.');
    const dominio = separador === -1 ? permiso : permiso.slice(0, separador);
    const cola = separador === -1 ? '' : permiso.slice(separador + 1);
    const accion = ACCIONES[cola] || cola || permiso;

    if (!grupos.has(dominio)) {
      grupos.set(dominio, { etiqueta: DOMINIOS[dominio] || dominio, acciones: [] });
    }
    grupos.get(dominio).acciones.push(accion);
  });

  return Array.from(grupos.values());
}

function loginForm(req, res) {
  res.render('login', { titulo: 'Login', csrfToken: res.locals.csrfToken });
}

function saludoPorHora() {
  const hora = new Date().getHours();
  if (hora < 12) return 'Buenos días';
  if (hora < 19) return 'Buenas tardes';
  return 'Buenas noches';
}

function fechaLarga() {
  const texto = new Date().toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' });
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

// Un box cuenta como "en uso ahora" si tiene una cita agendada hoy cuyo
// rango horario contiene la hora actual (comparación de strings "HH:MM",
// válida porque ambos lados están siempre en el mismo formato de 5 caracteres).
function contarBoxesEnUso(citasHoy) {
  const ahora = new Date().toTimeString().slice(0, 5);
  const enCurso = citasHoy.filter((c) => c.estado === 'agendada' && c.horaInicio <= ahora && ahora <= c.horaFin);
  return new Set(enCurso.map((c) => c.boxId)).size;
}

// Para el panel del dashboard: la cita en curso y las siguientes, no todas
// las del día. Usa la misma hora "ahora" que contarBoxesEnUso.
const CITAS_EN_PANEL = 3;

function citasProximas(citasHoy) {
  const ahora = new Date().toTimeString().slice(0, 5);
  return citasHoy.filter((c) => c.horaFin > ahora).slice(0, CITAS_EN_PANEL);
}

async function dashboard(req, res, next) {
  try {
    const usuario = req.usuario;
    const permisos = usuario.permisos;
    const hoy = hoyISO();

    const stats = [];
    let agendaHoy = { titulo: 'Agenda de hoy', href: '/agenda', items: [], total: 0 };
    const atajos = [];

    if (permisos.includes('agenda.write')) atajos.push({ etiqueta: 'Nueva cita', href: '/agenda/nueva', icono: 'agenda' });
    if (permisos.includes('paciente.write')) atajos.push({ etiqueta: 'Registrar paciente', href: '/pacientes/nuevo', icono: 'paciente' });
    if (permisos.includes('box.write')) atajos.push({ etiqueta: 'Gestionar espacios', href: '/espacios', icono: 'box' });
    if (permisos.includes('admin.users')) atajos.push({ etiqueta: 'Nuevo usuario', href: '/usuarios', icono: 'usuario' });
    if (permisos.includes('data.export') || permisos.includes('data.import')) {
      atajos.push({ etiqueta: 'Importar / exportar', href: '/datos', icono: 'datos' });
    }

    if (usuario.rolNombre === 'medico') {
      const medico = await medicoService.obtenerPorUsuarioId(usuario.id);
      if (medico) {
        const { items, total } = await citaService.listarCitas({ fecha: hoy, medicoId: medico.id, pageSize: 200 });
        stats.push({ etiqueta: 'Tus citas hoy', valor: total, icono: 'agenda' });
        agendaHoy = { titulo: 'Tu agenda de hoy', href: '/agenda/mia', items: citasProximas(items), total };
      }
    } else if (permisos.includes('agenda.read')) {
      const { items, total } = await citaService.listarCitas({ fecha: hoy, pageSize: 200 });
      stats.push({ etiqueta: 'Citas hoy', valor: total, icono: 'agenda' });
      agendaHoy = { titulo: 'Agenda de hoy', href: '/agenda', items: citasProximas(items), total };

      if (permisos.includes('box.read')) {
        stats.push({ etiqueta: 'Boxes en uso ahora', valor: contarBoxesEnUso(items), icono: 'box' });
      }
    }

    if (permisos.includes('paciente.read')) {
      stats.push({ etiqueta: 'Pacientes registrados', valor: await pacienteService.contar(), icono: 'paciente' });
    }

    stats.push({ etiqueta: 'Notificaciones sin leer', valor: await notificacionService.contarNoLeidas(usuario.id), icono: 'notificacion' });

    if (permisos.includes('admin.users')) {
      stats.push({ etiqueta: 'Usuarios del sistema', valor: await usuarioService.contar(), icono: 'usuario' });
    }

    res.render('dashboard', {
      titulo: 'Dashboard',
      usuario,
      csrfToken: res.locals.csrfToken,
      saludo: saludoPorHora(),
      fechaLarga: fechaLarga(),
      stats,
      atajos,
      agendaHoy,
      accesos: agruparAccesos(permisos),
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { loginForm, dashboard };
