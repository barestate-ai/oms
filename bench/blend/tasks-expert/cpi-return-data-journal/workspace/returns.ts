import { need, bytes, integer } from './strict.ts';
export function returnStore() {
  let value = { program: '', data: '' };
  return {
    clear() {},
    set(program, data) {
      need(bytes(data).length <= 1024);
      value = { program, data };
    },
    read(max) {
      integer(max, 1024);
      return [
        'return',
        value.program,
        bytes(value.data)
          .subarray(0, max + 1)
          .toString('hex'),
        value.data.length,
      ];
    },
    get value() {
      return { ...value };
    },
  };
}
