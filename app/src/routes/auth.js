const express = require('express');
const rateLimit = require('express-rate-limit');
const { login, logout } = require('../controllers/authController');
const { loginForm } = require('../controllers/viewController');
const { registrar, indiceEmail } = require('../services/auditService');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de inicio de sesión, intenta más tarde' },
  // Un intento bloqueado por el límite también queda en la auditoría (con el
  // HMAC del correo, si vino): es la señal de un ataque de fuerza bruta.
  handler: async (req, res, next, options) => {
    try {
      const email = typeof req.body.email === 'string' ? req.body.email : null;
      await registrar({
        accion: 'LOGIN_LIMITADO',
        entidad: 'Usuario',
        entidadId: 0,
        resultado: 'denegado',
        emailIndice: email ? indiceEmail(email) : null,
      });
      res.status(options.statusCode).json(options.message);
    } catch (err) {
      next(err);
    }
  },
});

const router = express.Router();

// El CSRF de doble envío se aplica globalmente en app.js a toda mutación,
// login/logout incluidos — no hace falta repetirlo aquí.
router.get('/login-form', loginForm); // avoids clashing with POST /auth/login
router.post('/login', loginLimiter, login);
router.post('/logout', logout);

module.exports = router;
