const crypto = require('crypto');
const writeExcelFile = require('write-excel-file/node').default;
const PDFDocument = require('pdfkit');
const { isoLocal, fechaDMA } = require('./fecha');
const { AppError } = require('./AppError');

// El archivo del titular (acceso y portabilidad) en tres formatos, con los
// mismos datos:
//   - JSON: para llevar los datos a otro responsable (portabilidad): un
//     formato estructurado y genérico que cualquier sistema lee.
//   - Excel (.xlsx): una hoja por sección y una fila por registro, para
//     revisarlo en una planilla. Los valores van como texto, nunca como
//     fórmula, así que un dato que empiece con "=" no se ejecuta al abrirlo.
//   - PDF: la misma información para leerla o imprimirla. No sirve para
//     portabilidad por sí solo: no es un formato que otro sistema pueda leer.
// Ninguno lleva datos de otras personas ni ids internos: son los mismos
// datos que arma derechosService.armarArchivoTitular.

const ETIQUETAS = {
  derecho: { acceso: 'Acceso', portabilidad: 'Portabilidad', rectificacion: 'Rectificación', supresion: 'Supresión', bloqueo: 'Bloqueo', oposicion: 'Oposición' },
  estadoSolicitud: { recibida: 'Pendiente de verificar la identidad', verificada: 'En evaluación', resuelta: 'Resuelta', rechazada: 'Rechazada' },
  resultadoSolicitud: { atendida: 'Atendida', parcial: 'Atendida en parte', rechazada: 'Rechazada' },
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
    PRORROGAR_DERECHO: 'Se prorrogó el plazo de una solicitud',
    AVISAR_ENTREGA: 'Aviso de que su copia está en el portal',
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
const LARGAS = ['Texto aceptado', 'Respuesta', 'Finalidad', 'Base legal', 'Motivo', 'Motivo de la prórroga', 'Origen'];

// Todas las fechas como día-mes-año, igual que en la interfaz: las marcas de
// tiempo con hora y minutos ("16-10-2026 10:12"), las fechas sin hora solas.
const fecha = (valor) => (valor ? fechaDMA(isoLocal(valor).slice(0, 16)) : '');
const dia = (iso) => (iso ? fechaDMA(iso.slice(0, 10)) : '');
const etiqueta = (grupo, valor) => (valor ? ETIQUETAS[grupo][valor] || valor : '');
// La fecha de nacimiento vigente viene como AAAA-MM-DD: se muestra igual que la anterior.
const campoVisible = (campo, valor) => (campo === 'fechaNacimiento' ? dia(valor) : valor);

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
      columnas: ['N°', 'Derecho', 'Dato', 'Canal', 'Recibida el', 'Verificada el', 'Vence el', 'Estado', 'Resultado', 'Resuelta el', 'Motivo de la prórroga', 'Respuesta'],
      filas: archivo.solicitudes.map((s) => [
        String(s.numero),
        etiqueta('derecho', s.derecho),
        etiqueta('campo', s.campo),
        etiqueta('canal', s.canal),
        fecha(s.recibidaEl),
        fecha(s.verificadaEl),
        fecha(s.venceEl) + (s.prorrogadaEl ? ' (prorrogada)' : ''),
        etiqueta('estadoSolicitud', s.estado),
        etiqueta('resultadoSolicitud', s.resultado),
        fecha(s.resueltaEl),
        s.motivoProrroga || '',
        s.respuesta || '',
      ]),
    },
    {
      titulo: 'Cambios de mis datos',
      columnas: ['Dato', 'Cambiado el', 'Valor anterior', 'Valor nuevo'],
      filas: archivo.historialCambios.map((h) => [
        etiqueta('campo', h.campo),
        fecha(h.cambiadoEl),
        h.valorAnterior === null ? '(eliminado)' : campoVisible(h.campo, h.valorAnterior),
        h.valorNuevo === null ? '(eliminado)' : campoVisible(h.campo, h.valorNuevo),
      ]),
    },
    {
      titulo: 'Accesos a mis datos',
      columnas: ['Fecha', 'Quién (función)', 'Qué', 'Resultado'],
      filas: archivo.accesos.map((a) => [fecha(a.fecha), a.rol, etiqueta('accion', a.accion), etiqueta('resultado', a.resultado)]),
    },
    {
      titulo: 'Cómo tratamos mis datos',
      columnas: ['Datos', 'Origen', 'Finalidad', 'Base legal', 'Plazo'],
      filas: [
        ...archivo.tratamiento.datos.map((d) => [`${d.categoria}: ${d.datos}`, d.origen, d.finalidad, d.base, d.plazo]),
        ['Destinatarios', '', archivo.tratamiento.destinatarios, '', ''],
        ['Responsable', '', archivo.tratamiento.responsable, '', ''],
        ['Cómo ejercer sus derechos', '', archivo.tratamiento.comoEjercerlos, '', ''],
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

// Ancho, en puntos, de las columnas "normales" de una tabla del PDF con texto
// largo: lo que quepa entre un mínimo legible y un máximo, para que las
// columnas largas conserven al menos su espacio mínimo.
const ANCHO_NORMAL_MAXIMO = 78;
const ANCHO_NORMAL_MINIMO = 40;
const ANCHO_LARGA_MINIMO = 120;

/**
 * Ancho de cada columna de una tabla del PDF. Sin columnas de texto largo,
 * todas se reparten el espacio por igual ('*'). Con ellas, las normales
 * se achican lo necesario para dejarles a las largas al menos 120 puntos
 * cada una: con 12 columnas (la tabla de solicitudes) un ancho fijo de 78 las
 * dejaba sin espacio y la respuesta del hospital se veía como letras apiladas.
 *
 * @param {string[]} columnas - los encabezados de la sección.
 * @param {number} anchoUtil - ancho de la página sin márgenes, en puntos.
 * @returns {Array<(number|'*')>} un ancho fijo por columna normal y '*' por
 *   cada larga, que se reparten lo que sobra.
 *
 * Consumidores: aPdf().
 */
function anchosPdf(columnas, anchoUtil) {
  const largas = columnas.filter((c) => LARGAS.includes(c)).length;
  if (largas === 0) return columnas.map(() => '*');
  const normales = columnas.length - largas;
  const normal = normales === 0 ? 0 : Math.floor(Math.max(ANCHO_NORMAL_MINIMO, Math.min(ANCHO_NORMAL_MAXIMO, (anchoUtil - largas * ANCHO_LARGA_MINIMO) / normales)));
  return columnas.map((c) => (LARGAS.includes(c) ? '*' : normal));
}

// La contraseña del PDF la elige el titular al pedirlo. No hay un máximo
// técnico, pero 64 evita abusos; el mínimo de 8 es lo que la guía de la clase
// y el estándar de contraseñas piden como piso.
const CLAVE_MINIMA = 8;
const CLAVE_MAXIMA = 64;

/**
 * La contraseña con que se protege el PDF: la exige si el formato es PDF y la
 * ignora en los demás. Se llama antes de generar el archivo, como
 * validarFormato(): generarlo resuelve la solicitud, y una contraseña inválida
 * no debe dejarla resuelta. No recorta la contraseña (los espacios cuentan) y
 * el mensaje nunca la repite.
 *
 * @param {string} formato - ya validado con validarFormato().
 * @param {*} clave - lo que llegó en la petición.
 * @returns {(string|null)} la contraseña, o null si el formato no se protege.
 * @throws {AppError} 400 si es un PDF y la contraseña no tiene de 8 a 64 caracteres.
 *
 * Consumidores: routes/portal.js, solicitudViewController.descargar.
 */
function claveDelPdf(formato, clave) {
  if (formato !== 'pdf') return null;
  if (typeof clave !== 'string' || clave.length < CLAVE_MINIMA || clave.length > CLAVE_MAXIMA) {
    throw new AppError(`El PDF se protege con una contraseña de ${CLAVE_MINIMA} a ${CLAVE_MAXIMA} caracteres: elige una para poder abrirlo`, 400);
  }
  return clave;
}

/**
 * @param {object} archivo - ver secciones().
 * @param {{clave?: string}} [opciones] - con `clave`, el PDF se cifra con AES-256
 *   y solo se abre con ella. El servidor no la guarda ni la registra. Los
 *   permisos dejan imprimirlo y copiarlo, pero no editarlo: la contraseña de
 *   propietario es aleatoria y se descarta, así que nadie puede cambiarlos.
 * @returns {Promise<Buffer>} un PDF con una tabla por sección.
 *
 * Consumidores: routes/portal.js, solicitudViewController.descargar.
 */
function aPdf(archivo, { clave } = {}) {
  return new Promise((resolve, reject) => {
    const proteccion = clave
      ? { userPassword: clave, ownerPassword: crypto.randomBytes(32).toString('hex'), pdfVersion: '1.7ext3', permissions: { printing: 'highResolution', modifying: false, copying: true, annotating: false, fillingForms: false, contentAccessibility: true, documentAssembly: false } }
      : {};
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, info: { Title: 'Mis datos en MediBox' }, ...proteccion });
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
        const anchos = anchosPdf(s.columnas, doc.page.width - doc.page.margins.left - doc.page.margins.right);
        doc.table({
          // Si la sección tiene texto largo, ese se lleva el ancho sobrante; si no, todas por igual.
          columnStyles: (i) => ({ width: anchos[i] }),
          rowStyles: (i) => (i === 0 ? { font: { src: 'Helvetica-Bold' }, backgroundColor: '#eeeeee' } : {}),
          data: [s.columnas, ...s.filas.map((fila) => fila.map((valor) => String(valor ?? '')))],
        });
      }
    }
    doc.end();
  });
}

/**
 * El archivo como JSON: el formato de la portabilidad por excelencia
 * (estructurado, genérico y de uso común, Ley 21.719, art. 9), que otro
 * sistema lee sin conocer MediBox. Las fechas van en ISO 8601, para una
 * máquina; son los mismos datos que el Excel y el PDF, sin ids internos.
 *
 * @param {object} archivo - ver secciones().
 * @returns {Buffer} UTF-8.
 *
 * Consumidores: enviarArchivo() (formato 'json').
 */
function aJson(archivo) {
  return Buffer.from(JSON.stringify({ formato: 'medibox-titular', version: 1, ...archivo }, null, 2), 'utf8');
}

const FORMATOS = {
  excel: { extension: 'xlsx', tipo: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', generar: aExcel },
  pdf: { extension: 'pdf', tipo: 'application/pdf', generar: aPdf },
  json: { extension: 'json', tipo: 'application/json; charset=utf-8', generar: aJson },
};

/**
 * Valida el formato pedido. Se llama antes de generar el archivo: generarlo
 * resuelve la solicitud, y un formato inválido no debe dejarla resuelta.
 *
 * @param {*} valor - 'excel', 'pdf' o 'json'.
 * @returns {string} el mismo valor, ya validado.
 * @throws {AppError} 400 con cualquier otro valor.
 *
 * Consumidores: routes/portal.js, solicitudViewController.descargar.
 */
function validarFormato(valor) {
  if (!Object.prototype.hasOwnProperty.call(FORMATOS, valor)) throw new AppError('Elige el formato: Excel, PDF o JSON', 400);
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
 * @param {{clave?: (string|null)}} [opciones] - la contraseña del PDF, ya
 *   validada con claveDelPdf().
 * @returns {Promise<void>}
 *
 * Consumidores: routes/portal.js, solicitudViewController.descargar.
 */
async function enviarArchivo(res, archivo, formato, nombre, { clave } = {}) {
  const { extension, tipo, generar } = FORMATOS[formato];
  const contenido = await generar(archivo, { clave });
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', tipo);
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}.${extension}"`);
  res.send(contenido);
}

module.exports = { ETIQUETAS, secciones, aExcel, aPdf, anchosPdf, aJson, validarFormato, claveDelPdf, enviarArchivo };
