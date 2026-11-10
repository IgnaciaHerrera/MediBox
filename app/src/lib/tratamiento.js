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
      origen: 'Los entregó usted (o su representante) al registrarse en admisión.',
      finalidad: 'Identificar sin ambigüedad a quien se atiende en la agenda y en la atención.',
      base: 'Tratamiento por un órgano público en sus funciones legales (Ley 19.628, art. 20; Ley 21.719, art. 20).',
      plazo: 'Al menos 15 años (Ley 20.584, art. 13).',
    },
    {
      categoria: 'Contacto',
      datos: 'Teléfono o correo (opcional)',
      origen: 'Lo entregó usted en admisión o lo corrigió en una rectificación.',
      finalidad: 'Avisar cambios o anulaciones de las citas y, solo con consentimiento, enviar recordatorios o encuestas.',
      base: 'Órgano público (avisos); consentimiento (recordatorios y encuestas).',
      plazo: 'Se elimina tras dos años sin citas.',
    },
    {
      categoria: 'Salud',
      datos: 'Citas (fecha, médico, especialidad, box y estado) y motivo de consulta',
      origen: 'Las genera el hospital al agendar y atender; el motivo lo registra admisión con lo que usted informa.',
      finalidad: 'Coordinar y orientar la atención de salud.',
      base: 'Dato de salud para la asistencia sanitaria (Ley 19.628, art. 10; Ley 21.719, art. 16 bis letra e; Ley 20.584, arts. 12 y 13).',
      plazo: 'Al menos 15 años (Ley 20.584, art. 13).',
    },
    {
      categoria: 'Trazabilidad',
      datos: 'Registro de quién accedió a sus datos, cuándo y para qué',
      origen: 'Lo genera el sistema automáticamente.',
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
  // Cómo ejercer los derechos, por partes: /privacidad muestra cada canal por
  // separado; la exportación usa el texto corrido de comoEjercerlos (abajo).
  ejercicio: {
    canales: [
      { donde: 'En el portal del paciente', enlace: '/portal', como: 'con su RUT y un código que llega al contacto que tiene registrado' },
      { donde: 'En admisión', como: 'con su cédula' },
      { donde: 'Por teléfono o por correo' },
    ],
    condiciones: [
      'Para la supresión y el bloqueo se pide la cédula en persona.',
      'El hospital acusa recibo con un número de seguimiento y responde dentro de 30 días corridos, prorrogables una vez por 30 días más; un bloqueo, dentro de 2 días hábiles (Ley 21.719, art. 11).',
      'Es gratuito.',
    ],
  },
};

/**
 * Arma el texto corrido de cómo ejercer los derechos a partir de sus partes:
 * los canales separados por punto y coma, y luego las condiciones.
 *
 * @param {{canales: {donde: string, enlace?: string, como?: string}[], condiciones: string[]}} ejercicio
 * @returns {string} p. ej. "En el portal del paciente (/portal), con su RUT…; en admisión, con su cédula; … Es gratuito."
 *
 * Consumidores: TRATAMIENTO.comoEjercerlos, que lee lib/archivoTitular.js
 * (exportación de los datos al titular).
 */
function textoEjercicio({ canales, condiciones }) {
  const frases = canales.map((c, i) => {
    const frase = c.donde + (c.enlace ? ` (${c.enlace})` : '') + (c.como ? `, ${c.como}` : '');
    return i === 0 ? frase : frase.charAt(0).toLowerCase() + frase.slice(1);
  });
  return `${frases.join('; ')}. ${condiciones.join(' ')}`;
}

TRATAMIENTO.comoEjercerlos = textoEjercicio(TRATAMIENTO.ejercicio);

// Lo que el hospital trata por ley y no depende del consentimiento: la
// oposición no procede (Ley 21.719, art. 20). Se registra igual, y se responde
// con un rechazo fundado con la base legal de cada uno (las mismas de la
// política de arriba). La clave es la que llega en la solicitud de oposición.
const TRATAMIENTOS_POR_LEY = {
  atencion: {
    nombre: 'La atención de salud y la agenda',
    fundamento:
      'El hospital trata su identificación y los datos de sus citas como órgano público de salud, en sus funciones legales (Ley 19.628, art. 20; Ley 21.719, art. 20), y debe conservar el registro clínico al menos 15 años (Ley 20.584, art. 13).',
  },
  avisos: {
    nombre: 'Los avisos de cambios o anulaciones de citas',
    fundamento:
      'Forman parte de la atención: sin ellos el hospital no puede avisarle que una cita cambió o se anuló. Se hacen como órgano público, en sus funciones legales (Ley 21.719, art. 20).',
  },
  trazabilidad: {
    nombre: 'El registro de quién accedió a sus datos',
    fundamento:
      'Es una obligación legal de resguardar los datos (Ley 19.628, art. 11; Ley 21.719, art. 14 quinquies) y es lo que le permite a usted saber quién accedió a ellos. Se conserva al menos 15 años, igual que su registro clínico.',
  },
};

module.exports = { TRATAMIENTO, TRATAMIENTOS_POR_LEY };
