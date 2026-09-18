const express = require('express');
const rateLimit = require('express-rate-limit');
const { login, logout } = require('../controllers/authController');
const { loginForm } = require('../controllers/viewController');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de inicio de sesión, intenta más tarde' },
});

const router = express.Router();

// El CSRF de doble envío se aplica globalmente en app.js a toda mutación,
// login/logout incluidos — no hace falta repetirlo aquí.
router.get('/login-form', loginForm); // avoids clashing with POST /auth/login
router.post('/login', loginLimiter, login);
router.post('/logout', logout);

module.exports = router;
