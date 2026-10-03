const Joi = require('joi');
const pacienteService = require('../services/pacienteService');
const citaService = require('../services/citaService');
const { AppError } = require('../lib/AppError');
const { normalizarRut, rutValido } = require('../lib/rut');
const { toast } = require('../lib/toast');
const { hoyISO } = require('../lib/fecha');

const pacienteSchema = Joi.object({
  nombre: Joi.string().min(2).max(150).required(),
  rut: Joi.string()
    .max(12)
    .required()
    .custom((valor, helpers) =>
      rutValido(valor) ? normalizarRut(valor) : helpers.message('El RUT no es válido: revisa el dígito verificador'),
    ),
  fechaNacimiento: Joi.date().iso().required(),
  contacto: Joi.string().min(5).max(100).required(),
}).unknown(true); // el formulario HTML envía además el campo _csrf

async function index(req, res, next) {
  try {
    const page = Number(req.query.page) || 1;
    const q = req.query.q || '';
    const pageSize = 20;
    const { items: pacientes, total } = await pacienteService.listarPacientes({ page, pageSize, q }, req.usuario.id);
    res.render('pacientes/index', {
      titulo: 'Pacientes',
      usuario: req.usuario,
      csrfToken: res.locals.csrfToken,
      pacientes,
      total,
      page,
      q,
      totalPaginas: Math.max(1, Math.ceil(total / pageSize)),
      puedeRegistrar: req.usuario.permisos.includes('paciente.write'),
    });
  } catch (err) {
    next(err);
  }
}

const CITAS_POR_PAGINA = 10;

// Separa las citas del paciente en próximas (agendadas que aún no terminan,
// de la más cercana a la más lejana) e historial (el resto, de la más
// reciente a la más antigua). El historial se pagina; las próximas se
// muestran completas.
function separarCitas(citas, paginaPedida) {
  const hoy = hoyISO();
  const ahora = new Date().toTimeString().slice(0, 5);
  const proximas = [];
  const historial = [];
  citas.forEach((cita) => {
    const fecha = cita.fecha.toISOString().slice(0, 10);
    const pendiente = !cita.anulada && cita.estado === 'agendada' && (fecha > hoy || (fecha === hoy && cita.horaFin > ahora));
    (pendiente ? proximas : historial).push(cita);
  });
  const totalPaginas = Math.max(1, Math.ceil(historial.length / CITAS_POR_PAGINA));
  const page = Math.min(Math.max(1, Number(paginaPedida) || 1), totalPaginas);
  return {
    proximas: proximas.reverse(),
    historial: historial.slice((page - 1) * CITAS_POR_PAGINA, page * CITAS_POR_PAGINA),
    totalHistorial: historial.length,
    page,
    totalPaginas,
  };
}

async function detalle(req, res, next) {
  try {
    const id = Number(req.params.id);
    const paciente = await pacienteService.obtenerPacientePorId(id, req.usuario.id);
    // Las citas solo se muestran a quien puede ver la agenda.
    const verCitas = req.usuario.permisos.includes('agenda.read');
    const citas = verCitas ? separarCitas(await citaService.listarPorPaciente(id), req.query.page) : null;
    res.render('pacientes/detalle', {
      titulo: paciente.nombre,
      usuario: req.usuario,
      csrfToken: res.locals.csrfToken,
      paciente,
      citas,
      puedeAgendar: req.usuario.permisos.includes('agenda.write'),
      puedeEditar: req.usuario.permisos.includes('paciente.write'),
    });
  } catch (err) {
    next(err);
  }
}

async function nuevaForm(req, res) {
  res.render('pacientes/formulario', {
    titulo: 'Registrar paciente',
    usuario: req.usuario,
    csrfToken: res.locals.csrfToken,
    accion: '/pacientes/nuevo',
    valores: req.query,
    error: null,
    esEdicion: false,
  });
}

async function crear(req, res, next) {
  try {
    const { error, value } = pacienteSchema.validate(req.body);
    if (error) {
      return res.status(400).render('pacientes/formulario', {
        titulo: 'Registrar paciente',
        usuario: req.usuario,
        csrfToken: res.locals.csrfToken,
        accion: '/pacientes/nuevo',
        valores: req.body,
        error: error.details[0].message,
        esEdicion: false,
      });
    }

    const paciente = await pacienteService.crearPaciente(value, req.usuario.id);
    toast(req, 'Paciente registrado');
    return res.redirect(`/pacientes/${paciente.id}`);
  } catch (err) {
    if (err instanceof AppError) {
      return res.status(err.statusCode).render('pacientes/formulario', {
        titulo: 'Registrar paciente',
        usuario: req.usuario,
        csrfToken: res.locals.csrfToken,
        accion: '/pacientes/nuevo',
        valores: req.body,
        error: err.message,
        esEdicion: false,
      });
    }
    return next(err);
  }
}

async function editarForm(req, res, next) {
  try {
    const id = Number(req.params.id);
    const paciente = await pacienteService.obtenerPacientePorId(id, req.usuario.id);
    res.render('pacientes/formulario', {
      titulo: `Editar ${paciente.nombre}`,
      usuario: req.usuario,
      csrfToken: res.locals.csrfToken,
      accion: `/pacientes/${id}/editar`,
      valores: { ...paciente, fechaNacimiento: paciente.fechaNacimiento.toISOString().slice(0, 10) },
      error: null,
      esEdicion: true,
    });
  } catch (err) {
    next(err);
  }
}

async function editar(req, res, next) {
  try {
    const id = Number(req.params.id);
    const { error, value } = pacienteSchema.validate(req.body);
    if (error) {
      return res.status(400).render('pacientes/formulario', {
        titulo: 'Editar paciente',
        usuario: req.usuario,
        csrfToken: res.locals.csrfToken,
        accion: `/pacientes/${id}/editar`,
        valores: req.body,
        error: error.details[0].message,
        esEdicion: true,
      });
    }

    await pacienteService.actualizarPaciente(id, value, req.usuario.id);
    toast(req, 'Datos del paciente actualizados');
    return res.redirect(`/pacientes/${id}`);
  } catch (err) {
    if (err instanceof AppError) {
      return res.status(err.statusCode).render('pacientes/formulario', {
        titulo: 'Editar paciente',
        usuario: req.usuario,
        csrfToken: res.locals.csrfToken,
        accion: `/pacientes/${req.params.id}/editar`,
        valores: req.body,
        error: err.message,
        esEdicion: true,
      });
    }
    return next(err);
  }
}

module.exports = { index, detalle, nuevaForm, crear, editarForm, editar };
