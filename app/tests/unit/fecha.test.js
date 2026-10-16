const { edadEnAnios } = require('../../src/lib/fecha');

describe('edadEnAnios', () => {
  it('cuenta el año recién el día del cumpleaños', () => {
    expect(edadEnAnios('2000-10-16', '2026-10-15')).toBe(25);
    expect(edadEnAnios('2000-10-16', '2026-10-16')).toBe(26);
  });

  it('da 0 a un lactante y respeta los nacidos un 29 de febrero', () => {
    expect(edadEnAnios('2026-03-01', '2026-10-16')).toBe(0);
    expect(edadEnAnios('2008-02-29', '2026-02-28')).toBe(17);
    expect(edadEnAnios('2008-02-29', '2026-03-01')).toBe(18);
  });
});
