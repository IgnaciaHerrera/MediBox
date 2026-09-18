const Joi = require('joi');
const { autenticar } = require('../services/authService');
const { AppError } = require('../lib/AppError');

const loginSchema = Joi.object({
  // tlds: { allow: false } porque el proyecto usa dominios internos ".local"
  // (ver prisma/seed.js y tests/unit/authService.test.js) que Joi rechazaría
  // por defecto al validar contra la lista de TLDs reales.
  email: Joi.string().email({ tlds: { allow: false } }).required(),
  password: Joi.string().min(8).required(),
}).unknown(true); // permite campos adicionales conocidos (p. ej. _csrf de formularios HTML)

async function login(req, res, next) {
  try {
    const { error, value } = loginSchema.validate(req.body);
    if (error) throw new AppError(error.details[0].message, 400);

    const usuario = await autenticar(value.email, value.password);
    if (!usuario) throw new AppError('Credenciales inválidas', 401);

    req.session.usuarioId = usuario.id;
    // `req.accepts('html')` solo (sin Accept header) sería truthy también para
    // clientes JSON (p. ej. supertest sin cabecera Accept explícita), lo que
    // rompería a los consumidores de la API. Se exige además que el cuerpo de
    // la petición NO sea JSON (los formularios HTML envían
    // application/x-www-form-urlencoded) para decidir el redirect de navegador.
    if (req.accepts('html') && !req.is('json')) {
      return res.redirect('/dashboard');
    }
    return res.status(200).json({ ok: true, usuario: { id: usuario.id, nombre: usuario.nombre } });
  } catch (err) {
    // Un navegador que falla el login debe ver el formulario de nuevo con el
    // error, no un JSON crudo — los clientes de API (tests, integraciones)
    // siguen recibiendo la respuesta JSON de siempre vía next(err).
    if (err instanceof AppError && req.accepts('html') && !req.is('json')) {
      return res.status(err.statusCode).render('login', {
        titulo: 'Login',
        csrfToken: res.locals.csrfToken,
        error: err.message,
      });
    }
    return next(err);
  }
}

function logout(req, res, next) {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('connect.sid');
    if (req.accepts('html') && !req.is('json')) {
      return res.redirect('/auth/login-form');
    }
    return res.status(200).json({ ok: true });
  });
}

module.exports = { login, logout };
