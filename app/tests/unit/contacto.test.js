const { enmascararContacto } = require('../../src/lib/contacto');

describe('enmascararContacto', () => {
  it('deja ver solo el prefijo y los últimos 4 dígitos de un teléfono', () => {
    expect(enmascararContacto('+56911112222')).toBe('+56 9 •••• 2222');
    expect(enmascararContacto('+56 9 1111 2222')).toBe('+56 9 •••• 2222');
  });

  it('deja ver solo la inicial y el dominio de un correo', () => {
    expect(enmascararContacto('ana.perez@mail.cl')).toBe('a•••@mail.cl');
  });

  it('oculta por completo un contacto demasiado corto para enmascararlo', () => {
    expect(enmascararContacto('12345')).toBe('•••');
  });
});
