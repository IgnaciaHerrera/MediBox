const Joi = require('joi');
const citaService = require('../services/citaService');
const medicoService = require('../services/medicoService');
const boxService = require('../services/boxService');
const pasilloService = require('../services/pasilloService');
const pacienteService = require('../services/pacienteService');
const auditService = require('../services/auditService');
const { AppError } = require('../lib/AppError');
const { hoyISO } = require('../lib/fecha');
const { toast } = require('../lib/toast');

const crearCitaSchema = Joi.object({
  pacienteId: Joi.number().integer().positive().required(),
  medicoId: Joi.number().integer().positive().required(),
  boxId: Joi.number().integer().positive().required(),
  fecha: Joi.date().iso().required(),
  horaInicio: Joi.string().pattern(/^\d{2}:\d{2}$/).required(),
  horaFin: Joi.string().pattern(/^\d{2}:\d{2}$/).required(),
  motivoConsulta: Joi.string().trim().min(2).max(300).required(),
}).unknown(true); // el formulario HTML envía además el campo _csrf

async function index(req, res, next) {
  try {
    const fecha = req.query.fecha || hoyISO();
    const { boxId, medicoId, pasilloId } = req.query;
    const vista = req.query.vista === 'calendario' ? 'calendario' : 'lista';

    const [{ items: citas }, boxesTodos, medicos, pasillos] = await Promise.all([
      citaService.listarCitas({ fecha, boxId, medicoId, pasilloId, pageSize: 100 }),
      boxService.listar(),
      medicoService.listar(),
      pasilloService.listar(),
    ]);

    // El pasillo acota qué boxes se ofrecen en el filtro de box y qué
    // columnas se dibujan en el calendario, sin necesidad de repetir esta
    // lógica en la vista.
    const boxes = pasilloId ? boxesTodos.filter((b) => b.pasilloId === Number(pasilloId)) : boxesTodos;

    res.render('agenda/index', {
      titulo: 'Agenda',
      usuario: req.usuario,
      csrfToken: res.locals.csrfToken,
      citas,
      boxes,
      medicos,
      pasillos,
      fecha,
      hoy: hoyISO(),
      vista,
      boxIdSeleccionado: boxId ? Number(boxId) : null,
      medicoIdSeleccionado: medicoId ? Number(medicoId) : null,
      pasilloIdSeleccionado: pasilloId ? Number(pasilloId) : null,
      modoMia: false,
      puedeCrear: req.usuario.permisos.includes('agenda.write'),
    });
  } catch (err) {
    next(err);
  }
}

async function mia(req, res, next) {
  try {
    const medico = await medicoService.obtenerPorUsuarioId(req.usuario.id);
    const fecha = req.query.fecha || hoyISO();

    if (!medico) {
      return res.render('agenda/index', {
        titulo: 'Mi agenda',
        usuario: req.usuario,
        csrfToken: res.locals.csrfToken,
        citas: [],
        boxes: [],
        medicos: [],
        pasillos: [],
        fecha,
        hoy: hoyISO(),
        vista: 'lista',
        boxIdSeleccionado: null,
        medicoIdSeleccionado: null,
        pasilloIdSeleccionado: null,
        modoMia: true,
        sinPerfilMedico: true,
        puedeCrear: false,
      });
    }

    const { items: citas } = await citaService.listarCitas({ fecha, medicoId: medico.id, pageSize: 100 });

    return res.render('agenda/index', {
      titulo: 'Mi agenda',
      usuario: req.usuario,
      csrfToken: res.locals.csrfToken,
      citas,
      boxes: [],
      medicos: [],
      pasillos: [],
      fecha,
      hoy: hoyISO(),
      vista: 'lista',
      boxIdSeleccionado: null,
      medicoIdSeleccionado: medico.id,
      pasilloIdSeleccionado: null,
      modoMia: true,
      sinPerfilMedico: false,
      puedeCrear: false,
    });
  } catch (err) {
    return next(err);
  }
}

async function nuevaForm(req, res, next) {
  try {
    const [{ items: pacientes }, medicos, boxes] = await Promise.all([
      pacienteService.listarPacientes({ page: 1, pageSize: 200 }, req.usuario.id),
      medicoService.listar(),
      boxService.listar(),
    ]);

    res.render('agenda/nueva', {
      titulo: 'Nueva cita',
      usuario: req.usuario,
      csrfToken: res.locals.csrfToken,
      pacientes,
      medicos,
      boxes,
      valores: req.query,
      error: null,
    });
  } catch (err) {
    next(err);
  }
}

async function crear(req, res, next) {
  try {
    const { error, value } = crearCitaSchema.validate(req.body);
    if (error) {
      const [{ items: pacientes }, medicos, boxes] = await Promise.all([
        pacienteService.listarPacientes({ page: 1, pageSize: 200 }, req.usuario.id),
        medicoService.listar(),
        boxService.listar(),
      ]);
      return res.status(400).render('agenda/nueva', {
        titulo: 'Nueva cita',
        usuario: req.usuario,
        csrfToken: res.locals.csrfToken,
        pacientes,
        medicos,
        boxes,
        valores: req.body,
        error: error.details[0].message,
      });
    }

    const cita = await citaService.crearCita(value, req.usuario.id);
    toast(req, 'Cita agendada');
    return res.redirect(`/agenda?fecha=${value.fecha}#cita-${cita.id}`);
  } catch (err) {
    if (err instanceof AppError) {
      const [{ items: pacientes }, medicos, boxes] = await Promise.all([
        pacienteService.listarPacientes({ page: 1, pageSize: 200 }, req.usuario.id),
        medicoService.listar(),
        boxService.listar(),
      ]);
      return res.status(err.statusCode).render('agenda/nueva', {
        titulo: 'Nueva cita',
        usuario: req.usuario,
        csrfToken: res.locals.csrfToken,
        pacientes,
        medicos,
        boxes,
        valores: req.body,
        error: err.message,
      });
    }
    return next(err);
  }
}

async function detalle(req, res, next) {
  try {
    const id = Number(req.params.id);
    const cita = await citaService.obtenerCitaPorId(id);

    // El motivo es un dato clínico del paciente: se muestra solo a quien
    // puede leer al paciente, junto con esa lectura auditada.
    let paciente = null;
    let motivoConsulta = null;
    if (req.usuario.permisos.includes('paciente.read')) {
      paciente = await pacienteService.obtenerPacientePorId(cita.pacienteId, req.usuario.id);
      motivoConsulta = await citaService.obtenerMotivo(id);
    }

    let historial = null;
    if (req.usuario.permisos.includes('auditoria.read')) {
      historial = await auditService.listarPorEntidad('Cita', id);
    }

    res.render('agenda/detalle', {
      titulo: 'Detalle de cita',
      usuario: req.usuario,
      csrfToken: res.locals.csrfToken,
      cita,
      paciente,
      motivoConsulta,
      historial,
      puedeGestionar: req.usuario.permisos.includes('agenda.write'),
    });
  } catch (err) {
    next(err);
  }
}

async function cambiarEstado(req, res, next) {
  try {
    const id = Number(req.params.id);
    await citaService.actualizarEstadoCita(id, req.body.estado, req.usuario.id);
    toast(req, 'Estado de la cita actualizado');
    res.redirect(`/agenda/${id}`);
  } catch (err) {
    next(err);
  }
}

async function anular(req, res, next) {
  try {
    const id = Number(req.params.id);
    await citaService.anularCita(id, req.usuario.id);
    toast(req, 'Cita anulada');
    res.redirect('/agenda');
  } catch (err) {
    next(err);
  }
}

module.exports = { index, mia, nuevaForm, crear, detalle, cambiarEstado, anular };
