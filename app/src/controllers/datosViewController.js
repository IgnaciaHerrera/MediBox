const Joi = require('joi');
const pacienteService = require('../services/pacienteService');
const citaService = require('../services/citaService');
const auditService = require('../services/auditService');
const datosService = require('../services/datosService');
const { toCsv } = require('../lib/csv');
const { AppError } = require('../lib/AppError');

const importarSchema = Joi.object({
  csv: Joi.string().min(1).required(),
}).unknown(true);

// Filtros de la exportación (llegan por query string desde los formularios
// de la pestaña Exportar). Vacíos o ausentes significan "sin filtro".
const fechaFiltro = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).empty('');
const filtrosCitasSchema = Joi.object({
  desde: fechaFiltro,
  hasta: fechaFiltro,
  estado: Joi.string().valid('agendada', 'atendido', 'no_atendido', 'anulada').empty(''),
});
const filtrosAuditoriaSchema = Joi.object({
  desde: fechaFiltro,
  hasta: fechaFiltro,
  accion: Joi.string().pattern(/^[A-Z_]+$/).max(40).empty(''),
});

function validarFiltros(schema, query) {
  const { error, value } = schema.validate(query, { stripUnknown: true });
  if (error) throw new AppError(error.details[0].message, 400);
  return value;
}

function enviarCsv(res, nombreArchivo, contenido) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivo}"`);
  res.send(contenido);
}

// Una tarjeta por entidad exportable, cada una con la fecha de su exportación
// más reciente (quien la generó y cuándo) leída del propio registro de
// auditoría — no hace falta una tabla nueva, ya queda todo trazado ahí.
const ENTIDADES_EXPORTABLES = [
  { entidad: 'Paciente', etiqueta: 'Pacientes', permiso: 'paciente.read', url: '/datos/exportar/pacientes.csv' },
  { entidad: 'Cita', etiqueta: 'Agenda de citas', permiso: 'agenda.read', url: '/datos/exportar/citas.csv' },
  { entidad: 'AuditLog', etiqueta: 'Registro de auditoría', permiso: 'auditoria.read', url: '/datos/exportar/auditoria.csv' },
];

async function datosVista(permisos) {
  const tarjetasExport = await construirTarjetasExport(permisos);
  const accionesAuditoria = tarjetasExport.some((t) => t.entidad === 'AuditLog')
    ? await auditService.listarAccionesDistintas()
    : [];
  return { tarjetasExport, accionesAuditoria };
}

async function construirTarjetasExport(permisos) {
  if (!permisos.includes('data.export')) return [];
  const disponibles = ENTIDADES_EXPORTABLES.filter((e) => permisos.includes(e.permiso));
  return Promise.all(
    disponibles.map(async (e) => ({
      ...e,
      ultimo: await auditService.obtenerUltimoRegistro({ accion: 'EXPORT', entidad: e.entidad }),
    })),
  );
}

async function index(req, res, next) {
  try {
    res.render('datos/index', {
      titulo: 'Importar y exportar datos',
      usuario: req.usuario,
      csrfToken: res.locals.csrfToken,
      error: null,
      resultado: null,
      ...(await datosVista(req.usuario.permisos)),
    });
  } catch (err) {
    next(err);
  }
}

async function exportarPacientes(req, res, next) {
  try {
    const pacientes = await pacienteService.listarTodosParaExport(req.usuario.id);
    // Fechas en ISO, igual que en los CSV de citas y auditoría: con
    // Date.toString() dependían de la zona horaria del servidor y la fecha de
    // nacimiento podía salir un día antes.
    const filas = pacientes.map((p) => ({
      ...p,
      fechaNacimiento: p.fechaNacimiento.toISOString().slice(0, 10),
      createdAt: p.createdAt.toISOString(),
    }));
    const csv = toCsv(['id', 'nombre', 'rut', 'fechaNacimiento', 'contacto', 'createdAt'], filas);
    enviarCsv(res, 'pacientes.csv', csv);
  } catch (err) {
    next(err);
  }
}

async function exportarCitas(req, res, next) {
  try {
    const filtros = validarFiltros(filtrosCitasSchema, req.query);
    const citas = await citaService.listarTodasParaExport(req.usuario.id, filtros);
    const filas = citas.map((c) => ({
      id: c.id,
      pacienteId: c.pacienteId,
      medico: c.medico.nombre,
      pasillo: c.box.pasillo.nombre,
      box: c.box.nombre,
      fecha: c.fecha.toISOString().slice(0, 10),
      horaInicio: c.horaInicio,
      horaFin: c.horaFin,
      estado: c.estado,
      anulada: c.anulada,
    }));
    const csv = toCsv(
      ['id', 'pacienteId', 'medico', 'pasillo', 'box', 'fecha', 'horaInicio', 'horaFin', 'estado', 'anulada'],
      filas,
    );
    enviarCsv(res, 'citas.csv', csv);
  } catch (err) {
    next(err);
  }
}

async function exportarAuditoria(req, res, next) {
  try {
    const filtros = validarFiltros(filtrosAuditoriaSchema, req.query);
    const registros = await auditService.listarTodo(req.usuario.id, filtros);
    const filas = registros.map((r) => ({
      id: r.id,
      fecha: r.timestamp.toISOString(),
      usuario: r.usuario ? r.usuario.nombre : '',
      accion: r.accion,
      entidad: r.entidad,
      entidadId: r.entidadId,
    }));
    const csv = toCsv(['id', 'fecha', 'usuario', 'accion', 'entidad', 'entidadId'], filas);
    enviarCsv(res, 'auditoria.csv', csv);
  } catch (err) {
    next(err);
  }
}

async function importarEspacios(req, res, next) {
  try {
    const { error, value } = importarSchema.validate(req.body);
    if (error) throw new AppError(error.details[0].message, 400);

    const resultado = await datosService.importarEspacios(value.csv, req.usuario.id);
    res.render('datos/index', {
      titulo: 'Importar y exportar datos',
      usuario: req.usuario,
      csrfToken: res.locals.csrfToken,
      error: null,
      resultado,
      ...(await datosVista(req.usuario.permisos)),
    });
  } catch (err) {
    if (err instanceof AppError) {
      return res.status(err.statusCode).render('datos/index', {
        titulo: 'Importar y exportar datos',
        usuario: req.usuario,
        csrfToken: res.locals.csrfToken,
        error: err.message,
        resultado: null,
        ...(await datosVista(req.usuario.permisos)),
      });
    }
    return next(err);
  }
}

module.exports = { index, exportarPacientes, exportarCitas, exportarAuditoria, importarEspacios };
