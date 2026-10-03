const { PrismaClient } = require('@prisma/client');

// El motivo de consulta de una cita es un dato clínico cifrado: ninguna
// consulta de citas lo trae salvo que lo pida con
// `omit: { motivoConsultaCifrado: false }` (solo citaService lo hace).
const prisma = new PrismaClient({ omit: { cita: { motivoConsultaCifrado: true } } });

module.exports = { prisma };
