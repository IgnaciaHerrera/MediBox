const express = require('express');
const rateLimit = require('express-rate-limit');
const { login, logout } = require('../controllers/authController');
const { loginForm } = require('../controllers/viewController');
const { verifyCsrf } = require('../middleware/csrf');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de inicio de sesión, intenta más tarde' },
});

const router = express.Router();

router.get('/login-form', loginForm); // avoids clashing with POST /auth/login
router.post('/login', loginLimiter, verifyCsrf, login);
router.post('/logout', verifyCsrf, logout);

module.exports = router;
