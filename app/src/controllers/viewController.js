function loginForm(req, res) {
  res.render('login', { titulo: 'Login', csrfToken: res.locals.csrfToken });
}

function dashboard(req, res) {
  res.render('dashboard', { titulo: 'Dashboard', usuario: req.usuario });
}

module.exports = { loginForm, dashboard };
