const Joi = require('joi');
const usuarioService = require('../services/usuarioService');
const rolService = require('../services/rolService');
const medicoService = require('../services/medicoService');
const { AppError } = require('../lib/AppError');
const { toast } = require('../lib/toast');

const crearSchema = Joi.object({
  nombre: Joi.string().min(2).max(150).required(),
  email: Joi.string().email({ tlds: { allow: false } }).required(),
  password: Joi.string().min(8).required(),
  rolId: Joi.number().integer().positive().required(),
  medicoId: Joi.number().integer().positive().allow(null, '').optional(),
}).unknown(true);

const editarSchema = Joi.object({
  nombre: Joi.string().min(2).max(150).required(),
  rolId: Joi.number().integer().positive().required(),
  nuevaPassword: Joi.string().min(8).allow('').optional(),
  medicoId: Joi.number().integer().positive().allow(null, '').optional(),
}).unknown(true);

// El rol "medico" es el único con el que el formulario ofrece vincular un
// perfil de médico; el id se resuelve por nombre para no hardcodearlo.
async function obtenerRolMedicoId() {
  const rolMedico = await rolService.listar().then((roles) => roles.find((r) => r.nombre === 'medico'));
  return rolMedico ? rolMedico.id : null;
}

async function index(req, res, next) {
  try {
    const [usuarios, roles, medicos, rolMedicoId] = await Promise.all([
      usuarioService.listar(),
      rolService.listar(),
      medicoService.listar(),
      obtenerRolMedicoId(),
    ]);
    res.render('usuarios/index', {
      titulo: 'Usuarios',
      usuario: req.usuario,
      csrfToken: res.locals.csrfToken,
      usuarios,
      roles,
      medicos,
      rolMedicoId,
      error: null,
    });
  } catch (err) {
    next(err);
  }
}

async function crear(req, res, next) {
  try {
    const { error, value } = crearSchema.validate(req.body);
    if (error) throw new AppError(error.details[0].message, 400);
    await usuarioService.crear(value);
    toast(req, 'Usuario creado');
    return res.redirect('/usuarios');
  } catch (err) {
    if (err instanceof AppError) {
      const [usuarios, roles, medicos, rolMedicoId] = await Promise.all([
        usuarioService.listar(),
        rolService.listar(),
        medicoService.listar(),
        obtenerRolMedicoId(),
      ]);
      return res.status(err.statusCode).render('usuarios/index', {
        titulo: 'Usuarios', usuario: req.usuario, csrfToken: res.locals.csrfToken, usuarios, roles, medicos, rolMedicoId, error: err.message,
      });
    }
    return next(err);
  }
}

async function editarForm(req, res, next) {
  try {
    const id = Number(req.params.id);
    const [usuarioEditar, roles, medicos, rolMedicoId] = await Promise.all([
      usuarioService.obtenerPorId(id),
      rolService.listar(),
      medicoService.listar(),
      obtenerRolMedicoId(),
    ]);
    res.render('usuarios/editar', {
      titulo: `Editar ${usuarioEditar.nombre}`,
      usuario: req.usuario,
      csrfToken: res.locals.csrfToken,
      usuarioEditar,
      roles,
      medicos,
      rolMedicoId,
      esUnoMismo: req.usuario.id === usuarioEditar.id,
      error: null,
    });
  } catch (err) {
    next(err);
  }
}

async function editar(req, res, next) {
  try {
    const id = Number(req.params.id);
    const { error, value } = editarSchema.validate(req.body);
    if (error) throw new AppError(error.details[0].message, 400);

    await usuarioService.actualizar(id, { nombre: value.nombre, rolId: value.rolId, medicoId: value.medicoId }, req.usuario.id);
    if (value.nuevaPassword) {
      await usuarioService.cambiarPassword(id, value.nuevaPassword);
    }
    toast(req, 'Usuario actualizado');
    return res.redirect('/usuarios');
  } catch (err) {
    if (err instanceof AppError) {
      const [usuarioEditar, roles, medicos, rolMedicoId] = await Promise.all([
        usuarioService.obtenerPorId(Number(req.params.id)),
        rolService.listar(),
        medicoService.listar(),
        obtenerRolMedicoId(),
      ]);
      return res.status(err.statusCode).render('usuarios/editar', {
        titulo: 'Editar usuario', usuario: req.usuario, csrfToken: res.locals.csrfToken, usuarioEditar, roles, medicos, rolMedicoId, esUnoMismo: req.usuario.id === usuarioEditar.id, error: err.message,
      });
    }
    return next(err);
  }
}

module.exports = { index, crear, editarForm, editar };
