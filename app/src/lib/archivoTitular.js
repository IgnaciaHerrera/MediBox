const writeExcelFile = require('write-excel-file/node').default;
const PDFDocument = require('pdfkit');
const { isoLocal, fechaDMA } = require('./fecha');
const { AppError } = require('./AppError');

// El archivo del titular (acceso y portabilidad) en dos formatos, con las
// mismas secciones:
//   - Excel (.xlsx): una hoja por sección y una fila por registro. Es el de
//     la portabilidad: estructurado y de uso común, para llevar los datos a
//     otro responsable. Los valores van como texto, nunca como fórmula, así
//     que un dato que empiece con "=" no se ejecuta al abrir el archivo.
//   - PDF: la misma información para leerla o imprimirla. No sirve para
//     portabilidad por sí solo: no es un formato que otro sistema pueda leer.
// Ninguno lleva datos de otras personas ni ids internos: son los mismos
// datos que arma derechosService.armarArchivoTitular.

const ETIQUETAS = {
  derecho: { acceso: 'Acceso', portabilidad: 'Portabilidad', rectificacion: 'Rectificación', supresion: 'Supresión', bloqueo: 'Bloqueo', oposicion: 'Oposición' },
  estadoSolicitud: { recibida: 'Pendiente de verificar la identidad', verificada: 'En revisión', resuelta: 'Resuelta', rechazada: 'Rechazada' },
  canal: { presencial: 'En admisión', telefono: 'Por teléfono', correo: 'Por correo', portal: 'En el portal' },
  campo: { nombre: 'Nombre', rut: 'RUT', fechaNacimiento: 'Fecha de nacimiento', contacto: 'Contacto' },
  estadoCita: { agendada: 'Agendada', atendido: 'Atendida', no_atendido: 'No atendida' },
  resultado: { exito: 'Permitido', denegado: 'Negado', fallido: 'Fallido' },
  accion: {
    READ: 'Consulta de sus datos',
    LIST: 'Aparece en un listado',
    CREATE: 'Registro de sus datos',
    UPDATE: 'Cambio de sus datos',
    EXPORT_TITULAR: 'Copia de sus datos',
    CONSENTIR: 'Otorgó un consentimiento',
    REVOCAR: 'Revocó un consentimiento',
    SOLICITAR: 'Presentó una solicitud',
    VERIFICAR_IDENTIDAD: 'Verificación de identidad',
    VERIFICACION_ENVIADA: 'Envío de un código de verificación',
    VERIFICAR_SOLICITUD: 'Verificación de una solicitud',
    EJECUTAR_DERECHO: 'Se resolvió una solicitud',
    RECHAZAR_DERECHO: 'Se rechazó una solicitud',
    BLOQUEAR: 'Bloqueo de sus datos',
    DESBLOQUEAR: 'Fin del bloqueo',
    ANOTAR_SUPRESION: 'Registro de su supresión',
    REAPLICAR_SUPRESION: 'Se volvió a aplicar su supresión',
    PORTAL_CODIGO: 'Pedido de código del portal',
    PORTAL_INGRESO: 'Ingreso al portal',
  },
};

// Columnas de texto largo: más anchas en el Excel y las que se reparten el
// espacio sobrante en el PDF.
const LARGAS = ['Texto aceptado', 'Respuesta', 'Finalidad', 'Base legal', 'Motivo'];

// Todas las fechas como día-mes-año, igual que en la interfaz: las marcas de
// tiempo con hora y minutos ("16-10-2026 10:12"), las fechas sin hora solas.
const fecha = (valor) => (valor ? fechaDMA(isoLocal(valor).slice(0, 16)) : '');
const dia = (iso) => (iso ? fechaDMA(iso.slice(0, 10)) : '');
const etiqueta = (grupo, valor) => (valor ? ETIQUETAS[grupo][valor] || valor : '');

/**
 * Las secciones del archivo, como tablas: el único lugar que decide qué
 * columnas y en qué orden, para que el Excel y el PDF digan lo mismo.
 *
 * @param {object} archivo - lo que devuelve derechosService.armarArchivoTitular.
 * @returns {Array<{titulo: string, columnas: string[], filas: string[][]}>}
 *
 * Consumidores: aExcel(), aPdf().
 */
function secciones(archivo) {
  const t = archivo.titular;
  return [
    {
      titulo: 'Mis datos',
      columnas: ['Dato', 'Valor'],
      filas: [
        ['Nombre', t.nombre],
        ['RUT', t.rut],
        ['Fecha de nacimiento', dia(t.fechaNacimiento)],
        ['Contacto', t.contacto || 'Sin contacto registrado'],
        ['Registrado el', fecha(t.registradoEl)],
        ['Archivo generado el', fecha(archivo.generadoEl)],
      ],
    },
    {
      titulo: 'Citas',
      columnas: ['Fecha', 'Hora', 'Médico', 'Especialidad', 'Lugar', 'Estado', 'Motivo'],
      filas: archivo.citas.map((c) => [
        dia(c.fecha),
        `${c.horaInicio}-${c.horaFin}`,
        c.medico,
        c.especialidad,
        `${c.pasillo}, ${c.box}`,
        c.anulada ? 'Anulada' : etiqueta('estadoCita', c.estado),
        c.motivoConsulta || '',
      ]),
    },
    {
      titulo: 'Consentimientos',
      columnas: ['Uso', 'Versión', 'Otorgado el', 'Canal', 'Otorgado por', 'Revocado el', 'Canal de revocación', 'Texto aceptado'],
      filas: archivo.consentimientos.map((c) => [
        c.finalidad,
        String(c.versionTexto),
        fecha(c.otorgadoEl),
        etiqueta('canal', c.canal),
        c.otorgadoPor.charAt(0).toUpperCase() + c.otorgadoPor.slice(1),
        fecha(c.revocadoEl),
        etiqueta('canal', c.canalRevocacion),
        c.texto,
      ]),
    },
    {
      titulo: 'Solicitudes',
      columnas: ['Derecho', 'Dato', 'Canal', 'Recibida el', 'Vence el', 'Estado', 'Resuelta el', 'Respuesta'],
      filas: archivo.solicitudes.map((s) => [
        etiqueta('derecho', s.derecho),
        etiqueta('campo', s.campo),
        etiqueta('canal', s.canal),
        fecha(s.recibidaEl),
        fecha(s.venceEl),
        etiqueta('estadoSolicitud', s.estado),
        fecha(s.resueltaEl),
        s.respuesta || '',
      ]),
    },
    {
      titulo: 'Cambios de mis datos',
      columnas: ['Dato', 'Cambiado el', 'Valor anterior'],
      filas: archivo.historialCambios.map((h) => [etiqueta('campo', h.campo), fecha(h.cambiadoEl), h.valorAnterior === null ? '(eliminado)' : h.valorAnterior]),
    },
    {
      titulo: 'Accesos a mis datos',
      columnas: ['Fecha', 'Quién (función)', 'Qué', 'Resultado'],
      filas: archivo.accesos.map((a) => [fecha(a.fecha), a.rol, etiqueta('accion', a.accion), etiqueta('resultado', a.resultado)]),
    },
    {
      titulo: 'Cómo tratamos mis datos',
      columnas: ['Datos', 'Finalidad', 'Base legal', 'Plazo'],
      filas: [
        ...archivo.tratamiento.datos.map((d) => [`${d.categoria}: ${d.datos}`, d.finalidad, d.base, d.plazo]),
        ['Destinatarios', archivo.tratamiento.destinatarios, '', ''],
        ['Responsable', archivo.tratamiento.responsable, '', ''],
        ['Cómo ejercer sus derechos', archivo.tratamiento.comoEjercerlos, '', ''],
      ],
    },
  ];
}

/**
 * @param {object} archivo - ver secciones().
 * @returns {Promise<Buffer>} un .xlsx con una hoja por sección.
 *
 * Consumidores: routes/portal.js, solicitudViewController.descargar.
 */
function aExcel(archivo) {
  const hojas = secciones(archivo).map((s) => ({
    // Excel limita el nombre de una hoja a 31 caracteres.
    sheet: s.titulo.slice(0, 31),
    data: [s.columnas.map((c) => ({ value: c, fontWeight: 'bold' })), ...s.filas.map((fila) => fila.map((valor) => ({ value: String(valor ?? ''), wrap: true })))],
    columns: s.columnas.map((c) => ({ width: LARGAS.includes(c) ? 60 : 22 })),
  }));
  return writeExcelFile(hojas).toBuffer();
}

/**
 * @param {object} archivo - ver secciones().
 * @returns {Promise<Buffer>} un PDF con una tabla por sección.
 *
 * Consumidores: routes/portal.js, solicitudViewController.descargar.
 */
function aPdf(archivo) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, info: { Title: 'Mis datos en MediBox' } });
    const partes = [];
    doc.on('data', (parte) => partes.push(parte));
    doc.on('end', () => resolve(Buffer.concat(partes)));
    doc.on('error', reject);

    doc.font('Helvetica-Bold').fontSize(16).text('Mis datos en MediBox');
    doc.font('Helvetica').fontSize(9).text(`Copia de los datos personales de ${archivo.titular.nombre}, generada el ${fecha(archivo.generadoEl)}.`);
    for (const s of secciones(archivo)) {
      doc.moveDown(1).font('Helvetica-Bold').fontSize(12).text(s.titulo);
      doc.moveDown(0.3).font('Helvetica').fontSize(8);
      if (s.filas.length === 0) {
        doc.text('Sin registros.');
      } else {
        const conLargas = s.columnas.some((c) => LARGAS.includes(c));
        doc.table({
          // Si la sección tiene texto largo, ese se lleva el ancho sobrante; si no, todas por igual.
          columnStyles: (i) => ({ width: !conLargas || LARGAS.includes(s.columnas[i]) ? '*' : 78 }),
          rowStyles: (i) => (i === 0 ? { font: { src: 'Helvetica-Bold' }, backgroundColor: '#eeeeee' } : {}),
          data: [s.columnas, ...s.filas.map((fila) => fila.map((valor) => String(valor ?? '')))],
        });
      }
    }
    doc.end();
  });
}

const FORMATOS = {
  excel: { extension: 'xlsx', tipo: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', generar: aExcel },
  pdf: { extension: 'pdf', tipo: 'application/pdf', generar: aPdf },
};

/**
 * Valida el formato pedido. Se llama antes de generar el archivo: generarlo
 * resuelve la solicitud, y un formato inválido no debe dejarla resuelta.
 *
 * @param {*} valor - 'excel' o 'pdf'.
 * @returns {string} el mismo valor, ya validado.
 * @throws {AppError} 400 con cualquier otro valor.
 *
 * Consumidores: routes/portal.js, solicitudViewController.descargar.
 */
function validarFormato(valor) {
  if (!Object.prototype.hasOwnProperty.call(FORMATOS, valor)) throw new AppError('Elige el formato: Excel o PDF', 400);
  return valor;
}

/**
 * Responde con el archivo como descarga, sin que el navegador lo guarde en
 * caché (concentra datos sensibles).
 *
 * @param {object} res - respuesta de Express.
 * @param {object} archivo - ver secciones().
 * @param {string} formato - ya validado con validarFormato().
 * @param {string} nombre - nombre del archivo, sin extensión.
 * @returns {Promise<void>}
 *
 * Consumidores: routes/portal.js, solicitudViewController.descargar.
 */
async function enviarArchivo(res, archivo, formato, nombre) {
  const { extension, tipo, generar } = FORMATOS[formato];
  const contenido = await generar(archivo);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', tipo);
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}.${extension}"`);
  res.send(contenido);
}

module.exports = { ETIQUETAS, secciones, aExcel, aPdf, validarFormato, enviarArchivo };
