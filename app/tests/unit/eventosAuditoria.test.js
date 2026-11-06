const fs = require('fs');
const path = require('path');
const {
  EVENTOS,
  CATEGORIAS,
  validarEvento,
  esSensible,
} = require('../../src/lib/eventosAuditoria');

// El catálogo de eventos auditados es el contrato de la trazabilidad: lo que
// el código audita y lo que el catálogo declara deben ser lo mismo.

function archivosJs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const ruta = path.join(dir, e.name);
    if (e.isDirectory()) return archivosJs(ruta);
    return e.name.endsWith('.js') ? [ruta] : [];
  });
}

// Las acciones que el código pasa a registrar(): literales dentro de cada
// llamada (incluidas las de un operador ternario) y las asignadas a una
// variable `accion` o pasadas a limitador() del portal.
function accionesDelCodigo() {
  const acciones = new Set();
  for (const archivo of archivosJs(path.join(__dirname, '..', '..', 'src'))) {
    if (archivo.endsWith('eventosAuditoria.js')) continue;
    const texto = fs.readFileSync(archivo, 'utf8');
    for (const m of texto.matchAll(/registrar\(\s*\{[\s\S]*?\}\s*(?:,\s*\w+\s*)?\)/g)) {
      const llamada = m[0];
      const accion = /accion:\s*([^,}\n]+)/.exec(llamada);
      if (accion) for (const lit of accion[1].matchAll(/'([A-Z_]+)'/g)) acciones.add(lit[1]);
    }
    for (const m of texto.matchAll(/const accion = [^;]+;/g))
      for (const lit of m[0].matchAll(/'([A-Z_]+)'/g)) acciones.add(lit[1]);
    for (const m of texto.matchAll(/limitador\(\d+,\s*'([A-Z_]+)'\)/g)) acciones.add(m[1]);
  }
  return acciones;
}

describe('catálogo de eventos auditados', () => {
  const delCodigo = accionesDelCodigo();

  it('toda acción que el código audita está en el catálogo', () => {
    const faltan = [...delCodigo].filter((a) => !EVENTOS[a]);
    expect(faltan).toEqual([]);
  });

  it('el catálogo no declara acciones que nadie audita', () => {
    const sobran = Object.keys(EVENTOS).filter((a) => !delCodigo.has(a));
    expect(sobran).toEqual([]);
  });

  it('cada evento tiene categoría, descripción y entidades', () => {
    for (const [accion, e] of Object.entries(EVENTOS)) {
      expect({ accion, categoria: Boolean(CATEGORIAS[e.categoria]) }).toEqual({
        accion,
        categoria: true,
      });
      expect(e.descripcion.length).toBeGreaterThan(10);
      expect(e.entidades.length).toBeGreaterThan(0);
    }
  });

  it('cubre los eventos que pide la trazabilidad', () => {
    for (const accion of [
      'LOGIN',
      'LOGIN_FALLIDO',
      'LOGOUT',
      'READ',
      'CREATE',
      'UPDATE',
      'DELETE',
      'EXPORT',
      'UPDATE_ROL',
      'UPDATE_PERMISOS',
      'SOLICITAR',
      'EJECUTAR_DERECHO',
      'ACCESO_DENEGADO',
    ]) {
      expect(EVENTOS[accion]).toBeDefined();
    }
  });
});

describe('validarEvento', () => {
  it('acepta un evento del catálogo con un detalle de conteos y códigos', () => {
    expect(() =>
      validarEvento({
        accion: 'UPDATE',
        entidad: 'Paciente',
        detalle: { campos: ['nombre', 'contacto'] },
      }),
    ).not.toThrow();
    expect(() =>
      validarEvento({
        accion: 'PRESERVAR_EVIDENCIA',
        entidad: 'Sistema',
        detalle: {
          archivo: 'evidencia-2026-11-06T14-05-00-000Z.jsonl',
          sha256: 'a'.repeat(64),
          filas: 3,
        },
      }),
    ).not.toThrow();
    expect(() =>
      validarEvento({
        accion: 'COPIAR_AUDITORIA',
        entidad: 'Sistema',
        detalle: { archivo: 'auditoria_12345678_12349999.jsonl' },
      }),
    ).not.toThrow();
  });

  it('rechaza una acción desconocida o sobre una entidad que no corresponde', () => {
    expect(() => validarEvento({ accion: 'BORRAR_TODO', entidad: 'Paciente' })).toThrow(
      /desconocida/,
    );
    expect(() => validarEvento({ accion: 'LOGIN', entidad: 'Paciente' })).toThrow(
      /no se registra sobre/,
    );
  });

  it('rechaza un detalle que trae un correo, un RUT o un texto largo', () => {
    expect(() =>
      validarEvento({
        accion: 'UPDATE',
        entidad: 'Paciente',
        detalle: { anterior: 'ana@correo.cl' },
      }),
    ).toThrow(/dato personal/);
    expect(() =>
      validarEvento({
        accion: 'UPDATE',
        entidad: 'Paciente',
        detalle: { anterior: ['12.345.678-5'] },
      }),
    ).toThrow(/dato personal/);
    expect(() =>
      validarEvento({
        accion: 'UPDATE',
        entidad: 'Paciente',
        detalle: { anterior: { rut: '12345678-k' } },
      }),
    ).toThrow(/dato personal/);
    expect(() =>
      validarEvento({ accion: 'UPDATE', entidad: 'Paciente', detalle: { nota: 'x'.repeat(201) } }),
    ).toThrow(/texto de 201/);
  });
});

describe('esSensible', () => {
  it('marca los eventos que exponen o modifican datos de pacientes', () => {
    expect(esSensible('READ', 'Paciente')).toBe(true);
    expect(esSensible('UPDATE', 'Paciente')).toBe(true);
    expect(esSensible('UPDATE', 'Usuario')).toBe(false);
    expect(esSensible('LOGIN', 'Usuario')).toBe(false);
  });
});
