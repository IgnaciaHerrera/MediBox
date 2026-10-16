// Política de tratamiento de datos de MediBox (Ley 21.719, art. 14 ter), en
// una sola fuente: la usan la página pública /privacidad y la exportación de
// los datos al propio titular (derecho de acceso: qué datos, con qué
// finalidad y a quién se comunican). Resume el inventario del Hito 1.

const TRATAMIENTO = {
  responsable:
    'El hospital público que usa MediBox, como órgano público de salud. (A confirmar con la línea jurídica si el responsable es el hospital o el Servicio de Salud del que depende.)',
  datos: [
    {
      categoria: 'Identificación',
      datos: 'Nombre, RUT y fecha de nacimiento',
      finalidad: 'Identificar sin ambigüedad a quien se atiende en la agenda y en la atención.',
      base: 'Tratamiento por un órgano público en sus funciones legales (Ley 19.628, art. 20; Ley 21.719, art. 20).',
      plazo: 'Al menos 15 años (Ley 20.584, art. 13).',
    },
    {
      categoria: 'Contacto',
      datos: 'Teléfono o correo (opcional)',
      finalidad: 'Avisar cambios o anulaciones de las citas y, solo con consentimiento, enviar recordatorios o encuestas.',
      base: 'Órgano público (avisos); consentimiento (recordatorios y encuestas).',
      plazo: 'Se elimina tras dos años sin citas.',
    },
    {
      categoria: 'Salud',
      datos: 'Citas (fecha, médico, especialidad, box y estado) y motivo de consulta',
      finalidad: 'Coordinar y orientar la atención de salud.',
      base: 'Dato de salud para la asistencia sanitaria (Ley 19.628, art. 10; Ley 21.719, art. 16 bis letra e; Ley 20.584, arts. 12 y 13).',
      plazo: 'Al menos 15 años (Ley 20.584, art. 13).',
    },
    {
      categoria: 'Trazabilidad',
      datos: 'Registro de quién accedió a sus datos, cuándo y para qué',
      finalidad: 'Rendir cuentas de los accesos y detectar accesos indebidos.',
      base: 'Obligación legal de resguardar los datos (Ley 19.628, art. 11; Ley 21.719, art. 14 quinquies).',
      plazo: 'Al menos 15 años, igual que el registro del paciente.',
    },
  ],
  finalidades: [
    { clave: 'recordatorios', nombre: 'Recordatorios de citas', base: 'Consentimiento, revocable en cualquier momento.' },
    { clave: 'investigacion', nombre: 'Investigación y estadística con datos seudonimizados', base: 'Consentimiento, revocable en cualquier momento.' },
    { clave: 'encuestas', nombre: 'Encuestas de satisfacción', base: 'Consentimiento, revocable en cualquier momento.' },
  ],
  destinatarios:
    'Sus datos no se comunican a terceros fuera del hospital. Dentro del hospital, cada funcionario ve solo lo que su función requiere; los reportes de gestión e investigación salen seudonimizados.',
  derechos: ['acceso', 'rectificacion', 'supresion', 'oposicion', 'bloqueo', 'portabilidad'],
  comoEjercerlos:
    'En el portal del paciente (/portal), con su RUT y un código que llega al contacto que tiene registrado; en admisión, con su cédula; por teléfono o por correo. Para la supresión y el bloqueo se pide la cédula en persona. El hospital responde dentro de 30 días corridos (plazo a confirmar con la línea jurídica). Es gratuito.',
};

module.exports = { TRATAMIENTO };
