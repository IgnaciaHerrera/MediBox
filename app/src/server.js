require('dotenv').config();
const { revisarEntorno } = require('./lib/entorno');

const problemas = revisarEntorno();
if (problemas.length > 0) {
  // eslint-disable-next-line no-console
  console.error(`MediBox no arranca: configuración insegura o incompleta.\n- ${problemas.join('\n- ')}`);
  process.exit(1);
}

const app = require('./app');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`MediBox listening on port ${PORT}`);
});
