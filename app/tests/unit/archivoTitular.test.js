const { secciones, aExcel } = require('../../src/lib/archivoTitular');
const { textoDelExcel } = require('../helpers/archivo');

// Hora local: el archivo muestra las marcas de tiempo en la hora del servidor.
const alas = (texto) => new Date(texto);

const archivo = {
  titular: { nombre: 'Titular Fechas', rut: '20123456-5', fechaNacimiento: '2001-07-19', contacto: null, registradoEl: alas('2026-10-16T10:12:30') },
  generadoEl: alas('2026-10-23T09:05:00'),
  citas: [{ fecha: '2026-10-20', horaInicio: '09:00', horaFin: '09:30', medico: 'Dra. Prueba', especialidad: 'Pediatría', pasillo: 'Pasillo A', box: 'Box 1', estado: 'atendido', anulada: false, motivoConsulta: null }],
  consentimientos: [{ finalidad: 'Recordatorios', versionTexto: 1, otorgadoEl: alas('2026-10-16T10:12:00'), canal: 'presencial', otorgadoPor: 'titular', revocadoEl: alas('2026-10-20T18:40:00'), canalRevocacion: 'telefono', texto: 'Texto' }],
  solicitudes: [{ derecho: 'acceso', campo: null, canal: 'portal', recibidaEl: alas('2026-10-16T11:00:00'), venceEl: alas('2026-11-15T11:00:00'), estado: 'resuelta', resueltaEl: alas('2026-10-17T08:30:00'), respuesta: 'Entregado' }],
  historialCambios: [{ campo: 'contacto', cambiadoEl: alas('2026-10-18T12:00:00'), valorAnterior: '+56900000000' }],
  accesos: [{ fecha: alas('2026-10-19T15:45:00'), rol: 'operador', accion: 'READ', resultado: 'exito' }],
  tratamiento: { datos: [], destinatarios: 'Nadie', responsable: 'Hospital', comoEjercerlos: 'Portal' },
};

describe('archivo del titular: fechas', () => {
  const celdas = secciones(archivo).flatMap((s) => s.filas.flat());

  it('muestra todas las fechas como día-mes-año, igual que la interfaz', () => {
    expect(celdas).toEqual(expect.arrayContaining([
      '19-07-2001', // fecha de nacimiento
      '20-10-2026', // fecha de la cita
      '16-10-2026 10:12', // registro, sin segundos
      '23-10-2026 09:05', // archivo generado
      '20-10-2026 18:40', // revocación
      '15-11-2026 11:00', // vencimiento de la solicitud
      '18-10-2026 12:00', // cambio de un dato
      '19-10-2026 15:45', // acceso
    ]));
  });

  it('no deja ninguna fecha en formato año-mes-día', () => {
    expect(celdas.filter((c) => /\d{4}-\d{2}-\d{2}/.test(String(c)))).toEqual([]);
  });

  it('el Excel lleva las mismas fechas que el PDF, porque ambos salen de secciones()', async () => {
    const texto = textoDelExcel(await aExcel(archivo));
    expect(texto).toContain('19-07-2001');
    expect(texto).toContain('19-10-2026 15:45');
    expect(texto).not.toContain('2001-07-19');
  });
});
