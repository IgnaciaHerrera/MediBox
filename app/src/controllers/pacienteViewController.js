const Joi = require('joi');
const pacienteService = require('../services/pacienteService');
const citaService = require('../services/citaService');
const consentimientoService = require('../services/consentimientoService');
const derechosService = require('../services/derechosService');
const verificacionService = require('../services/verificacionService');
const { AppError } = require('../lib/AppError');
const { normalizarRut, rutValido } = require('../lib/rut');
const { toast } = require('../lib/toast');
const { responderAccion } = require('../lib/responderError');
const { hoyISO } = require('../lib/fecha');

const pacienteSchema = Joi.object({
  nombre: Joi.string().min(2).max(150).required(),
  rut: Joi.string()
    .max(12)
    .required()
    .custom((valor, helpers) =>
      rutValido(valor) ? normalizarRut(valor) : helpers.message('El RUT no es válido: revisa el dígito verificador'),
    ),
  fechaNacimiento: Joi.date().iso().max('now').required(),
  // Opcional: un campo vacío del formulario cuenta como "sin contacto".
  contacto: Joi.string().trim().min(5).max(100).empty(''),
}).unknown(true); // el formulario HTML envía además el campo _csrf

// La búsqueda llega por POST (/pacientes/buscar) y se muestra en la misma
// respuesta: el término no queda en la URL, en el historial ni en la sesión.
// La paginación de una búsqueda también va por POST.
async function index(req, res, next) {
  try {
    const enBusqueda = req.method === 'POST';
    const page = Number(enBusqueda ? req.body.page : req.query.page) || 1;
    const q = enBusqueda ? String(req.body.q || '').trim().slice(0, 150) : '';
    const pageSize = 20;
    const { items: pacientes, total } = await pacienteService.listarPacientes({ page, pageSize, q }, req.usuario);
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
    const paciente = await pacienteService.obtenerPacientePorId(id, req.usuario);
    // Las citas solo se muestran a quien puede ver la agenda.
    const verCitas = req.usuario.permisos.includes('agenda.read');
    const citas = verCitas ? separarCitas(await citaService.listarPorPaciente(id), req.query.page) : null;
    const historial = await pacienteService.listarHistorial(id);
    // Consentimientos: solo para quien los gestiona (el operador). El médico
    // no los necesita para atender.
    // Lo mismo con las solicitudes de derechos: las ve quien las recibe.
    const gestionaConsentimientos = req.usuario.permisos.includes('consentimiento.write');
    const recibeSolicitudes = req.usuario.permisos.includes('derechos.registrar');
    const consentimientos = gestionaConsentimientos ? await consentimientoService.estadoPorPaciente(id) : null;
    const solicitudes = recibeSolicitudes ? await derechosService.listarPorPaciente(id) : null;
    const verificacion = gestionaConsentimientos || recibeSolicitudes ? await verificacionService.estadoParaVista(id, req.usuario.id, paciente.contacto) : null;
    res.render('pacientes/detalle', {
      titulo: paciente.nombre,
      usuario: req.usuario,
      csrfToken: res.locals.csrfToken,
      paciente,
      citas,
      historial,
      consentimientos,
      solicitudes,
      verificacion,
      consentimiento: {
        canales: consentimientoService.CANALES,
        relaciones: consentimientoService.RELACIONES,
        requiereRepresentante: consentimientoService.requiereRepresentante(paciente.edad),
        esAdolescente: paciente.edad >= consentimientoService.EDAD_CONSENTIMIENTO_PROPIO && paciente.edad < 18,
      },
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
    const paciente = await pacienteService.obtenerPacientePorId(id, req.usuario);
    res.render('pacientes/formulario', {
      titulo: `Editar ${paciente.nombre}`,
      usuario: req.usuario,
      csrfToken: res.locals.csrfToken,
      accion: `/pacientes/${id}/editar`,
      valores: paciente,
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

const otorgarSchema = Joi.object({
  textoId: Joi.number().integer().positive().required(),
  canal: Joi.string().valid(...consentimientoService.CANALES).required().messages({ 'any.only': 'Indica por qué canal llegó la petición', 'any.required': 'Indica por qué canal llegó la petición' }),
  // Expreso: la casilla viene sin marcar y el silencio no es consentimiento.
  acepta: Joi.string().valid('si').required().messages({ 'any.only': 'Marca que el titular aceptó el texto', 'any.required': 'Marca que el titular aceptó el texto' }),
  representanteNombre: Joi.string().trim().allow(''),
  representanteRut: Joi.string().trim().allow(''),
  representanteRelacion: Joi.string().trim().allow(''),
}).unknown(true);

const revocarSchema = Joi.object({
  canal: Joi.string().valid(...consentimientoService.CANALES).required().messages({ 'any.only': 'Indica por qué canal llegó la petición', 'any.required': 'Indica por qué canal llegó la petición' }),
}).unknown(true);

function validar(schema, cuerpo) {
  const { error, value } = schema.validate(cuerpo);
  if (error) throw new AppError(error.details[0].message, 400);
  return value;
}

async function otorgarConsentimiento(req, res, next) {
  try {
    const value = validar(otorgarSchema, req.body);
    const representante = value.representanteNombre || value.representanteRut || value.representanteRelacion
      ? { nombre: value.representanteNombre, rut: value.representanteRut, relacion: value.representanteRelacion }
      : undefined;
    await consentimientoService.otorgar(
      { pacienteId: Number(req.params.id), finalidadClave: req.params.clave, textoId: value.textoId, canal: value.canal, representante },
      req.usuario,
    );
    responderAccion(req, res, 'Consentimiento registrado');
  } catch (err) {
    next(err);
  }
}

async function revocarConsentimiento(req, res, next) {
  try {
    const value = validar(revocarSchema, req.body);
    await consentimientoService.revocar({ pacienteId: Number(req.params.id), finalidadClave: req.params.clave, canal: value.canal }, req.usuario);
    responderAccion(req, res, 'Consentimiento revocado');
  } catch (err) {
    next(err);
  }
}

async function registrarSolicitud(req, res, next) {
  try {
    const { id } = await derechosService.registrarSolicitud({ ...req.body, pacienteId: Number(req.params.id) }, req.usuario);
    return responderAccion(req, res, 'Solicitud registrada. Verifica la identidad del titular para que privacidad pueda resolverla.', { id });
  } catch (err) {
    return next(err);
  }
}

async function verificarSolicitud(req, res, next) {
  try {
    await derechosService.verificarSolicitud(Number(req.params.sid), req.usuario, { pacienteId: Number(req.params.id) });
    responderAccion(req, res, 'Solicitud verificada');
  } catch (err) {
    next(err);
  }
}

module.exports = {
  index,
  detalle,
  nuevaForm,
  crear,
  editarForm,
  editar,
  otorgarConsentimiento,
  revocarConsentimiento,
  registrarSolicitud,
  verificarSolicitud,
};
