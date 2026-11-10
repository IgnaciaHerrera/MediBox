const fs = require('fs');
const os = require('os');
const path = require('path');
const { TAREAS, proximaEjecucion, crearProgramador, ejecutarScript } = require('../../src/lib/programador');

// Hora local: las tareas diarias se programan en la hora de Chile (TZ).
const a = (h, min = 0, dia = 8, mes = 10, anio = 2026) => new Date(anio, mes, dia, h, min, 0, 0);

describe('proximaEjecucion', () => {
  it('cada 15 minutos cae en :00, :15, :30 y :45, siempre después de ahora', () => {
    const tarea = { nombre: 'copiar', cadaMinutos: 15 };
    expect(proximaEjecucion(tarea, a(10, 7))).toEqual(a(10, 15));
    expect(proximaEjecucion(tarea, a(10, 15))).toEqual(a(10, 30));
    expect(proximaEjecucion(tarea, a(10, 44))).toEqual(a(10, 45));
    expect(proximaEjecucion(tarea, a(23, 50))).toEqual(a(0, 0, 9));
  });

  it('cada hora cae en punto', () => {
    expect(proximaEjecucion({ nombre: 'alertas', cadaMinutos: 60 }, a(10, 7))).toEqual(a(11, 0));
  });

  it('una tarea diaria corre hoy si su hora no pasó, y si no, mañana', () => {
    const tarea = { nombre: 'retencion', diaria: '08:00' };
    expect(proximaEjecucion(tarea, a(7, 0))).toEqual(a(8, 0));
    expect(proximaEjecucion(tarea, a(8, 0))).toEqual(a(8, 0, 9));
    expect(proximaEjecucion(tarea, a(9, 30))).toEqual(a(8, 0, 9));
  });

  it('una tarea diaria cruza el fin de mes', () => {
    expect(proximaEjecucion({ nombre: 'retencion', diaria: '08:00' }, a(9, 0, 30))).toEqual(a(8, 0, 1, 11));
  });
});

describe('tareas programadas', () => {
  it('cada una tiene nombre único, un solo modo de programación y un script que existe', () => {
    expect(new Set(TAREAS.map((t) => t.nombre)).size).toBe(TAREAS.length);
    for (const tarea of TAREAS) {
      expect([Boolean(tarea.cadaMinutos), Boolean(tarea.diaria)].filter(Boolean)).toHaveLength(1);
      if (tarea.diaria) expect(tarea.diaria).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
      expect(fs.existsSync(path.resolve(__dirname, '..', '..', 'src', tarea.script))).toBe(true);
    }
  });

  it('cubre los procesos de operación que el README pide programar', () => {
    const nombres = TAREAS.map((t) => t.nombre);
    expect(nombres).toEqual(expect.arrayContaining(['auditoria:copiar', 'auditoria:verificar', 'alertas', 'vencimientos', 'retencion', 'recordatorios', 'encuestas']));
  });

  it('copiar la auditoría es más frecuente que verificarla, y las alertas se revisan cada hora', () => {
    const porNombre = Object.fromEntries(TAREAS.map((t) => [t.nombre, t]));
    expect(porNombre['auditoria:copiar'].cadaMinutos).toBe(15);
    expect(porNombre.alertas.cadaMinutos).toBe(60);
    expect(porNombre['auditoria:verificar'].diaria).toBeDefined();
  });
});

describe('crearProgramador', () => {
  const log = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() });

  function armar(opciones = {}) {
    const pendientes = [];
    const ejecutar = opciones.ejecutar || jest.fn().mockResolvedValue({ codigo: 0 });
    const registro = log();
    const programador = crearProgramador({
      tareas: opciones.tareas || [{ nombre: 'copiar', script: 'x.js', cadaMinutos: 15 }],
      ejecutar,
      ahora: () => a(10, 7),
      setTimer: (fn, ms) => {
        const t = { fn, ms, cancelado: false };
        pendientes.push(t);
        return t;
      },
      clearTimer: (t) => {
        t.cancelado = true;
      },
      log: registro,
    });
    return { programador, pendientes, ejecutar, registro };
  }

  it('programa cada tarea para su próxima hora', () => {
    const { programador, pendientes } = armar({ tareas: [{ nombre: 'copiar', script: 'x.js', cadaMinutos: 15 }, { nombre: 'retencion', script: 'y.js', diaria: '08:00' }] });
    programador.iniciar();
    expect(pendientes.map((p) => p.ms)).toEqual([8 * 60 * 1000, (a(8, 0, 9) - a(10, 7))]);
  });

  it('al llegar la hora ejecuta la tarea y la vuelve a programar', async () => {
    const { programador, pendientes, ejecutar } = armar();
    programador.iniciar();
    await pendientes[0].fn();
    expect(ejecutar).toHaveBeenCalledTimes(1);
    expect(pendientes).toHaveLength(2);
  });

  it('una tarea que falla o termina con error no detiene a las demás: se registra y sigue', async () => {
    const ejecutar = jest.fn().mockRejectedValueOnce(new Error('no pudo arrancar')).mockResolvedValueOnce({ codigo: 1 });
    const { programador, pendientes, registro } = armar({ ejecutar });
    programador.iniciar();
    await pendientes[0].fn();
    await pendientes[1].fn();
    expect(registro.error).toHaveBeenCalledTimes(2);
    expect(pendientes).toHaveLength(3);
  });

  it('no empieza una tarea si la anterior sigue en curso', async () => {
    let terminar;
    const ejecutar = jest.fn(() => new Promise((resolver) => { terminar = () => resolver({ codigo: 0 }); }));
    const { programador, registro } = armar({ ejecutar });
    const primera = programador.correr({ nombre: 'copiar', script: 'x.js', cadaMinutos: 15 });
    const segunda = await programador.correr({ nombre: 'copiar', script: 'x.js', cadaMinutos: 15 });
    expect(segunda).toEqual({ omitida: true });
    expect(registro.warn).toHaveBeenCalled();
    expect(ejecutar).toHaveBeenCalledTimes(1);
    terminar();
    await primera;
  });

  it('detener cancela lo pendiente y no vuelve a programar', async () => {
    const { programador, pendientes } = armar();
    programador.iniciar();
    programador.detener();
    expect(pendientes[0].cancelado).toBe(true);
    await pendientes[0].fn();
    expect(pendientes).toHaveLength(1);
  });
});

describe('ejecutarScript', () => {
  const directorio = fs.mkdtempSync(path.join(os.tmpdir(), 'medibox-tareas-'));
  const escribir = (nombre, codigo) => {
    const ruta = path.join(directorio, nombre);
    fs.writeFileSync(ruta, codigo);
    return ruta;
  };

  afterAll(() => fs.rmSync(directorio, { recursive: true, force: true }));

  it('devuelve el código con que terminó el script', async () => {
    expect(await ejecutarScript({ nombre: 'ok', script: escribir('ok.js', 'process.exit(0)') })).toEqual({ codigo: 0 });
    expect(await ejecutarScript({ nombre: 'mal', script: escribir('mal.js', 'process.exit(3)') })).toEqual({ codigo: 3 });
  });

  it('pasa los argumentos al script', async () => {
    const ruta = escribir('args.js', "process.exit(process.argv.includes('--solo-alertas') ? 7 : 0)");
    expect(await ejecutarScript({ nombre: 'args', script: ruta, args: ['--solo-alertas'] })).toEqual({ codigo: 7 });
  });

  it('corta un script que no termina', async () => {
    const colgado = escribir('colgado.js', 'setTimeout(() => {}, 60000)');
    expect(await ejecutarScript({ nombre: 'colgado', script: colgado, maxMinutos: 0.01 })).toEqual({ codigo: null, vencida: true });
  });
});
