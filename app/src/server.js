require('dotenv').config();
const { revisarEntorno, revisarRolBase } = require('./lib/entorno');

function noArrancar(problemas) {
  // eslint-disable-next-line no-console
  console.error(`MediBox no arranca: configuración insegura o incompleta.\n- ${problemas.join('\n- ')}`);
  process.exit(1);
}

const problemas = revisarEntorno();
if (problemas.length > 0) noArrancar(problemas);

const app = require('./app');
const { prisma } = require('./lib/prisma');

const PORT = process.env.PORT || 3000;

async function arrancar() {
  // En desarrollo y en las pruebas se admite el dueño de la base, que es
  // quien crea y limpia los datos de prueba.
  if (process.env.NODE_ENV === 'production') {
    const problemasRol = await revisarRolBase(prisma);
    if (problemasRol.length > 0) noArrancar(problemasRol);
  }
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`MediBox listening on port ${PORT}`);
  });
}

arrancar();
