// Catálogo de los eventos que MediBox audita: qué acciones existen, sobre qué
// entidades y qué significa cada una. auditService.registrar() rechaza una
// acción o una entidad que no esté aquí, así que el catálogo no se puede
// desactualizar sin que falle una prueba (tests/unit/eventosAuditoria.test.js
// revisa además que cada acción del código esté en el catálogo y al revés).
//
// Cada registro responde cinco preguntas, con estas columnas de audit_log:
//   - ¿Quién? usuario_id y actor: la cuenta que actuó, o el sistema, el
//     titular en el portal o quien pide un código en el portal. En un login
//     fallido, el HMAC del correo intentado (email_indice), nunca el correo.
//   - ¿Qué hizo? accion: una de las acciones de este catálogo.
//   - ¿Sobre qué? entidad y entidad_id: el tipo de registro y su id interno;
//     0 para una lista, una exportación o el sistema.
//   - ¿Cuándo y desde dónde? timestamp e ip: la hora del servidor de base de
//     datos (un solo reloj para todos los eventos) y la IP de la petición; los
//     procesos del sistema no tienen IP.
//   - ¿Con qué resultado? resultado: exito, denegado (sin permiso o
//     bloqueado) o fallido (credencial o código incorrecto).
//   - Contexto: detalle, con conteos, ids internos, nombres de campos y
//     códigos. Nunca el valor de un dato personal: validarEvento() rechaza un
//     correo, un RUT o un texto largo.

const CATEGORIAS = {
  sesion: 'Sesiones e identidad',
  registros: 'Altas, cambios y bajas de registros',
  cuentas: 'Cuentas, roles y permisos',
  paciente: 'Datos de pacientes',
  derechos: 'Consentimientos y derechos del titular',
  agenda: 'Agenda y personal',
  datos: 'Exportaciones e importaciones',
  incidentes: 'Alertas e incidentes',
  sistema: 'Procesos del sistema',
};

// sensible: el evento expone o modifica datos de pacientes (lo que más
// importa reconstruir en una brecha).
const EVENTOS = {
  LOGIN: { categoria: 'sesion', entidades: ['Usuario'], descripcion: 'Inicio de sesión exitoso.' },
  LOGIN_FALLIDO: {
    categoria: 'sesion',
    entidades: ['Usuario'],
    descripcion: 'Inicio de sesión con credenciales inválidas o con una cuenta suspendida.',
  },
  LOGIN_LIMITADO: {
    categoria: 'sesion',
    entidades: ['Usuario'],
    descripcion: 'Inicio de sesión rechazado por el límite de intentos.',
  },
  LOGOUT: {
    categoria: 'sesion',
    entidades: ['Usuario'],
    descripcion: 'Cierre de sesión pedido por el usuario.',
  },
  REAUTENTICAR: {
    categoria: 'sesion',
    entidades: ['Usuario'],
    descripcion: 'Confirmación de la contraseña antes de una acción irreversible.',
  },
  REAUTENTICAR_LIMITADO: {
    categoria: 'sesion',
    entidades: ['Usuario'],
    descripcion: 'Confirmación de contraseña rechazada por el límite de intentos.',
  },
  CERRAR_SESIONES: {
    categoria: 'sesion',
    entidades: ['Usuario'],
    descripcion: 'Cierre forzado de las sesiones abiertas de una cuenta.',
  },
  ACCESO_DENEGADO: {
    categoria: 'cuentas',
    entidades: ['Sistema'],
    descripcion:
      'Intento de usar una función sin el permiso que exige (fuera de los datos de pacientes).',
  },

  CREATE: {
    categoria: 'registros',
    entidades: ['Usuario', 'Paciente', 'Cita', 'Medico'],
    descripcion: 'Creación de un registro.',
    sensible: ['Paciente', 'Cita'],
  },
  UPDATE: {
    categoria: 'registros',
    entidades: ['Usuario', 'Paciente', 'Medico'],
    descripcion: 'Modificación de un registro; el detalle nombra los campos, nunca sus valores.',
    sensible: ['Paciente'],
  },
  DELETE: {
    categoria: 'registros',
    entidades: ['Medico'],
    descripcion: 'Eliminación de un registro.',
  },
  UPDATE_ROL: {
    categoria: 'cuentas',
    entidades: ['Usuario'],
    descripcion: 'Cambio del rol de una cuenta.',
  },
  UPDATE_PERMISOS: {
    categoria: 'cuentas',
    entidades: ['Rol'],
    descripcion: 'Cambio de los permisos de un rol.',
  },
  UPDATE_PASSWORD: {
    categoria: 'cuentas',
    entidades: ['Usuario'],
    descripcion: 'Cambio de contraseña (cierra las demás sesiones de la cuenta).',
  },
  SUSPENDER_CUENTA: {
    categoria: 'cuentas',
    entidades: ['Usuario'],
    descripcion: 'Suspensión de una cuenta durante un incidente.',
  },
  REACTIVAR_CUENTA: {
    categoria: 'cuentas',
    entidades: ['Usuario'],
    descripcion: 'Reactivación de una cuenta suspendida.',
  },

  READ: {
    categoria: 'paciente',
    entidades: ['Paciente'],
    descripcion: 'Consulta de la ficha de un paciente, o el intento negado de hacerlo.',
    sensible: true,
  },
  LIST: {
    categoria: 'paciente',
    entidades: ['Paciente', 'AuditLog'],
    descripcion: 'Búsqueda o listado de pacientes, o consulta del registro de auditoría.',
    sensible: ['Paciente'],
  },
  BLOQUEAR: {
    categoria: 'paciente',
    entidades: ['Paciente'],
    descripcion: 'Bloqueo temporal del tratamiento de un paciente.',
    sensible: true,
  },
  DESBLOQUEAR: {
    categoria: 'paciente',
    entidades: ['Paciente'],
    descripcion: 'Fin del bloqueo temporal.',
    sensible: true,
  },
  VERIFICACION_ENVIADA: {
    categoria: 'paciente',
    entidades: ['Paciente'],
    descripcion: 'Envío de un código de verificación al contacto del paciente.',
  },
  VERIFICAR_IDENTIDAD: {
    categoria: 'paciente',
    entidades: ['Paciente'],
    descripcion: 'Verificación de la identidad del titular con un código.',
  },

  CONSENTIR: {
    categoria: 'derechos',
    entidades: ['Paciente'],
    descripcion: 'Otorgamiento de un consentimiento.',
  },
  REVOCAR: {
    categoria: 'derechos',
    entidades: ['Paciente'],
    descripcion: 'Revocación de un consentimiento.',
  },
  SOLICITAR: {
    categoria: 'derechos',
    entidades: ['Paciente'],
    descripcion: 'Registro de una solicitud de derechos.',
  },
  VERIFICAR_SOLICITUD: {
    categoria: 'derechos',
    entidades: ['Paciente'],
    descripcion: 'Verificación de la identidad en una solicitud de derechos.',
  },
  PRORROGAR_DERECHO: {
    categoria: 'derechos',
    entidades: ['Paciente'],
    descripcion: 'Prórroga del plazo de una solicitud.',
  },
  EJECUTAR_DERECHO: {
    categoria: 'derechos',
    entidades: ['Paciente'],
    descripcion: 'Resolución favorable de una solicitud.',
    sensible: true,
  },
  RECHAZAR_DERECHO: {
    categoria: 'derechos',
    entidades: ['Paciente'],
    descripcion: 'Rechazo fundado de una solicitud.',
  },
  ANOTAR_SUPRESION: {
    categoria: 'derechos',
    entidades: ['Paciente'],
    descripcion: 'Anotación de una supresión para reaplicarla tras restaurar un respaldo.',
  },
  REAPLICAR_SUPRESION: {
    categoria: 'derechos',
    entidades: ['Paciente'],
    descripcion: 'Reaplicación de una supresión después de restaurar un respaldo.',
    sensible: true,
  },
  EXPORT_TITULAR: {
    categoria: 'derechos',
    entidades: ['Paciente'],
    descripcion: 'Entrega de sus datos al titular (acceso o portabilidad).',
    sensible: true,
  },
  AVISAR_ENTREGA: {
    categoria: 'derechos',
    entidades: ['Paciente'],
    descripcion: 'Aviso al titular de que su archivo está en el portal.',
  },
  PORTAL_INGRESO: {
    categoria: 'derechos',
    entidades: ['Paciente'],
    descripcion: 'Ingreso del titular al portal.',
  },
  PORTAL_CODIGO: {
    categoria: 'derechos',
    entidades: ['Paciente'],
    descripcion: 'Pedido de un código de ingreso al portal.',
  },
  PORTAL_LIMITADO: {
    categoria: 'derechos',
    entidades: ['Sistema'],
    descripcion: 'Pedido del portal rechazado por el límite por IP.',
  },

  ANULAR: {
    categoria: 'agenda',
    entidades: ['Cita'],
    descripcion: 'Anulación de una cita.',
    sensible: true,
  },
  UPDATE_ESTADO: {
    categoria: 'agenda',
    entidades: ['Cita'],
    descripcion: 'Cambio del estado de una cita.',
    sensible: true,
  },

  EXPORT: {
    categoria: 'datos',
    entidades: ['Paciente', 'Investigacion', 'Estadistica', 'Cita', 'AuditLog'],
    descripcion: 'Exportación de datos (seudonimizados, agregados o de auditoría).',
    sensible: ['Paciente', 'Investigacion', 'Cita'],
  },
  IMPORT: {
    categoria: 'datos',
    entidades: ['Espacio'],
    descripcion: 'Importación de espacios clínicos.',
  },

  ALERTAS: {
    categoria: 'incidentes',
    entidades: ['Sistema'],
    descripcion: 'Revisión automática de las reglas de alerta.',
  },
  REVISAR_ALERTA: {
    categoria: 'incidentes',
    entidades: ['Alerta'],
    descripcion: 'Revisión de una alerta: descartada o escalada a incidente.',
  },
  REGISTRAR_INCIDENTE: {
    categoria: 'incidentes',
    entidades: ['Incidente'],
    descripcion: 'Registro de un incidente de seguridad.',
  },
  ACTUALIZAR_INCIDENTE: {
    categoria: 'incidentes',
    entidades: ['Incidente'],
    descripcion: 'Actualización de lo que se sabe de un incidente.',
  },
  CAMBIAR_ESTADO_INCIDENTE: {
    categoria: 'incidentes',
    entidades: ['Incidente'],
    descripcion: 'Cambio de estado de un incidente.',
  },
  ACCION_INCIDENTE: {
    categoria: 'incidentes',
    entidades: ['Incidente'],
    descripcion: 'Acción del equipo de respuesta anotada en la bitácora.',
  },
  RECONSTRUIR: {
    categoria: 'incidentes',
    entidades: ['Incidente', 'Sistema'],
    descripcion: 'Reconstrucción de lo ocurrido desde la auditoría.',
  },
  ESTIMAR_ALCANCE: {
    categoria: 'incidentes',
    entidades: ['Sistema'],
    descripcion: 'Estimación de titulares y categorías afectados.',
  },
  PRESERVAR_EVIDENCIA: {
    categoria: 'incidentes',
    entidades: ['Sistema'],
    descripcion:
      'Copia de la auditoría de una ventana a un archivo de solo lectura, con su SHA-256.',
  },
  ROTAR_LLAVE: {
    categoria: 'incidentes',
    entidades: ['Sistema'],
    descripcion: 'Recifrado de los datos con una llave nueva.',
  },

  RECORDATORIO: {
    categoria: 'sistema',
    entidades: ['Sistema'],
    descripcion: 'Envío de los recordatorios de citas.',
  },
  ENCUESTA: {
    categoria: 'sistema',
    entidades: ['Sistema'],
    descripcion: 'Envío de las invitaciones a la encuesta de satisfacción.',
  },
  AVISO_VENCIMIENTOS: {
    categoria: 'sistema',
    entidades: ['Sistema'],
    descripcion: 'Aviso de solicitudes de derechos por vencer.',
  },
  RETENCION: {
    categoria: 'sistema',
    entidades: ['Sistema'],
    descripcion: 'Anonimización de los registros que cumplieron su plazo.',
  },
  PURGAR_AUDITORIA: {
    categoria: 'sistema',
    entidades: ['Sistema'],
    descripcion: 'Eliminación de la auditoría con más de 15 años.',
  },
  COPIAR_AUDITORIA: {
    categoria: 'sistema',
    entidades: ['Sistema'],
    descripcion: 'Copia de la auditoría nueva al almacenamiento externo, con su SHA-256.',
  },
  VERIFICAR_AUDITORIA: {
    categoria: 'sistema',
    entidades: ['Sistema'],
    descripcion: 'Comparación de la auditoría de la base con su copia externa.',
  },
};

// Un correo, un RUT (con o sin puntos) o un texto largo en el detalle es casi
// seguro un dato personal colado: el detalle lleva conteos y códigos.
const PARECE_CORREO = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PARECE_RUT = /\b\d{1,2}\.?\d{3}\.?\d{3}-[\dkK]\b/;
const LARGO_MAXIMO_TEXTO = 200;

function revisarValor(valor, ruta) {
  if (typeof valor === 'string') {
    if (valor.length > LARGO_MAXIMO_TEXTO)
      throw new Error(`Auditoría: el detalle ${ruta} es un texto de ${valor.length} caracteres`);
    if (PARECE_CORREO.test(valor) || PARECE_RUT.test(valor))
      throw new Error(`Auditoría: el detalle ${ruta} parece un dato personal`);
  } else if (Array.isArray(valor)) {
    valor.forEach((v, i) => revisarValor(v, `${ruta}[${i}]`));
  } else if (valor && typeof valor === 'object' && !(valor instanceof Date)) {
    Object.entries(valor).forEach(([k, v]) => revisarValor(v, `${ruta}.${k}`));
  }
}

/**
 * Comprueba que un evento esté en el catálogo y que su detalle no traiga
 * datos personales. Es un error de programación, no del usuario: lanza
 * Error (500) para que lo detecten las pruebas.
 *
 * @param {{accion: string, entidad: string, detalle?: object}} evento
 * @returns {void}
 * @throws {Error} si la acción no existe, la entidad no corresponde o el
 *   detalle trae un correo, un RUT o un texto de más de 200 caracteres.
 *
 * Consumidores: auditService.registrar().
 */
function validarEvento({ accion, entidad, detalle }) {
  const evento = EVENTOS[accion];
  if (!evento) throw new Error(`Auditoría: acción desconocida ${accion}`);
  if (!evento.entidades.includes(entidad))
    throw new Error(`Auditoría: ${accion} no se registra sobre ${entidad}`);
  if (detalle !== undefined && detalle !== null) revisarValor(detalle, 'detalle');
}

/**
 * Si un evento expone o modifica datos de pacientes.
 *
 * @param {string} accion
 * @param {string} entidad
 * @returns {boolean}
 *
 * Consumidores: incidenteService.reconstruir().
 */
function esSensible(accion, entidad) {
  const s = EVENTOS[accion] && EVENTOS[accion].sensible;
  return Array.isArray(s) ? s.includes(entidad) : Boolean(s);
}

module.exports = { CATEGORIAS, EVENTOS, validarEvento, esSensible };
