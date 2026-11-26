import test from 'node:test';
import assert from 'node:assert/strict';
import { solve } from './index.ts';
test('independent vector 1', () => {
  const input = {
    accounts: [
      {
        key: '0100000000000000000000000000000000000000000000000000000000000000',
        signer: false,
        writable: false,
      },
      {
        key: '0200000000000000000000000000000000000000000000000000000000000000',
        signer: false,
        writable: false,
      },
      {
        key: '53e66062bdb455aadb02dd6dc7e6c3704ba4d15680ee7288d404c22d12472685',
        signer: false,
        writable: true,
      },
      {
        key: '0900000000000000000000000000000000000000000000000000000000000000',
        signer: true,
        writable: true,
      },
    ],
    frame: {
      program: '0100000000000000000000000000000000000000000000000000000000000000',
      metas: [
        {
          key: '0200000000000000000000000000000000000000000000000000000000000000',
          signer: false,
          writable: false,
        },
        {
          key: '0100000000000000000000000000000000000000000000000000000000000000',
          signer: false,
          writable: false,
        },
        {
          key: '53e66062bdb455aadb02dd6dc7e6c3704ba4d15680ee7288d404c22d12472685',
          signer: false,
          writable: false,
        },
        {
          key: '53e66062bdb455aadb02dd6dc7e6c3704ba4d15680ee7288d404c22d12472685',
          signer: false,
          writable: true,
        },
        {
          key: '0900000000000000000000000000000000000000000000000000000000000000',
          signer: true,
          writable: true,
        },
      ],
      derived: [],
      children: [
        {
          program: '0200000000000000000000000000000000000000000000000000000000000000',
          metas: [
            {
              key: '0100000000000000000000000000000000000000000000000000000000000000',
              signer: false,
              writable: false,
            },
            {
              key: '53e66062bdb455aadb02dd6dc7e6c3704ba4d15680ee7288d404c22d12472685',
              signer: true,
              writable: true,
            },
            {
              key: '0900000000000000000000000000000000000000000000000000000000000000',
              signer: false,
              writable: false,
            },
          ],
          derived: [
            {
              key: '53e66062bdb455aadb02dd6dc7e6c3704ba4d15680ee7288d404c22d12472685',
              seeds: ['0000', ''],
            },
          ],
          children: [],
        },
      ],
    },
  };
  const original = structuredClone(input);
  assert.deepEqual(solve(input), [
    {
      program: '0100000000000000000000000000000000000000000000000000000000000000',
      metas: [
        {
          key: '0200000000000000000000000000000000000000000000000000000000000000',
          signer: false,
          writable: false,
        },
        {
          key: '0100000000000000000000000000000000000000000000000000000000000000',
          signer: false,
          writable: false,
        },
        {
          key: '53e66062bdb455aadb02dd6dc7e6c3704ba4d15680ee7288d404c22d12472685',
          signer: false,
          writable: true,
        },
        {
          key: '0900000000000000000000000000000000000000000000000000000000000000',
          signer: true,
          writable: true,
        },
      ],
    },
    {
      program: '0200000000000000000000000000000000000000000000000000000000000000',
      metas: [
        {
          key: '0100000000000000000000000000000000000000000000000000000000000000',
          signer: false,
          writable: false,
        },
        {
          key: '53e66062bdb455aadb02dd6dc7e6c3704ba4d15680ee7288d404c22d12472685',
          signer: true,
          writable: true,
        },
        {
          key: '0900000000000000000000000000000000000000000000000000000000000000',
          signer: false,
          writable: false,
        },
      ],
    },
  ]);
  assert.deepEqual(input, original);
});
test('independent vector 5', () => {
  const input = {
    accounts: [
      {
        key: '0100000000000000000000000000000000000000000000000000000000000000',
        signer: false,
        writable: false,
      },
      {
        key: '0200000000000000000000000000000000000000000000000000000000000000',
        signer: false,
        writable: false,
      },
      {
        key: 'febe3e0f7f73779f25a2915345967d7536485d9300d7ee3a373d25ab5aa7297b',
        signer: false,
        writable: true,
      },
      {
        key: '0900000000000000000000000000000000000000000000000000000000000000',
        signer: true,
        writable: true,
      },
    ],
    frame: {
      program: '0100000000000000000000000000000000000000000000000000000000000000',
      metas: [
        {
          key: '0200000000000000000000000000000000000000000000000000000000000000',
          signer: false,
          writable: false,
        },
        {
          key: '0100000000000000000000000000000000000000000000000000000000000000',
          signer: false,
          writable: false,
        },
        {
          key: 'febe3e0f7f73779f25a2915345967d7536485d9300d7ee3a373d25ab5aa7297b',
          signer: false,
          writable: false,
        },
        {
          key: 'febe3e0f7f73779f25a2915345967d7536485d9300d7ee3a373d25ab5aa7297b',
          signer: false,
          writable: true,
        },
        {
          key: '0900000000000000000000000000000000000000000000000000000000000000',
          signer: true,
          writable: true,
        },
      ],
      derived: [],
      children: [
        {
          program: '0200000000000000000000000000000000000000000000000000000000000000',
          metas: [
            {
              key: '0100000000000000000000000000000000000000000000000000000000000000',
              signer: false,
              writable: false,
            },
            {
              key: 'febe3e0f7f73779f25a2915345967d7536485d9300d7ee3a373d25ab5aa7297b',
              signer: true,
              writable: true,
            },
            {
              key: '0900000000000000000000000000000000000000000000000000000000000000',
              signer: false,
              writable: false,
            },
          ],
          derived: [
            {
              key: 'febe3e0f7f73779f25a2915345967d7536485d9300d7ee3a373d25ab5aa7297b',
              seeds: ['0400', ''],
            },
          ],
          children: [],
        },
      ],
    },
  };
  const original = structuredClone(input);
  assert.deepEqual(solve(input), [
    {
      program: '0100000000000000000000000000000000000000000000000000000000000000',
      metas: [
        {
          key: '0200000000000000000000000000000000000000000000000000000000000000',
          signer: false,
          writable: false,
        },
        {
          key: '0100000000000000000000000000000000000000000000000000000000000000',
          signer: false,
          writable: false,
        },
        {
          key: 'febe3e0f7f73779f25a2915345967d7536485d9300d7ee3a373d25ab5aa7297b',
          signer: false,
          writable: true,
        },
        {
          key: '0900000000000000000000000000000000000000000000000000000000000000',
          signer: true,
          writable: true,
        },
      ],
    },
    {
      program: '0200000000000000000000000000000000000000000000000000000000000000',
      metas: [
        {
          key: '0100000000000000000000000000000000000000000000000000000000000000',
          signer: false,
          writable: false,
        },
        {
          key: 'febe3e0f7f73779f25a2915345967d7536485d9300d7ee3a373d25ab5aa7297b',
          signer: true,
          writable: true,
        },
        {
          key: '0900000000000000000000000000000000000000000000000000000000000000',
          signer: false,
          writable: false,
        },
      ],
    },
  ]);
  assert.deepEqual(input, original);
});
