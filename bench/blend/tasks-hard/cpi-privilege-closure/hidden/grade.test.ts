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
test('independent vector 2', () => {
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
        key: '8198f877ede54a5018707c406c435b4751becbd59a06fb861978a2604813a79f',
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
          key: '8198f877ede54a5018707c406c435b4751becbd59a06fb861978a2604813a79f',
          signer: false,
          writable: false,
        },
        {
          key: '8198f877ede54a5018707c406c435b4751becbd59a06fb861978a2604813a79f',
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
              key: '8198f877ede54a5018707c406c435b4751becbd59a06fb861978a2604813a79f',
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
              key: '8198f877ede54a5018707c406c435b4751becbd59a06fb861978a2604813a79f',
              seeds: ['0100', ''],
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
          key: '8198f877ede54a5018707c406c435b4751becbd59a06fb861978a2604813a79f',
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
          key: '8198f877ede54a5018707c406c435b4751becbd59a06fb861978a2604813a79f',
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
test('independent vector 3', () => {
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
        key: 'e93d6b8d6e09fdc2969a23b533d11b7bf2063b7a385ed7fed2bd5a8312688c12',
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
          key: 'e93d6b8d6e09fdc2969a23b533d11b7bf2063b7a385ed7fed2bd5a8312688c12',
          signer: false,
          writable: false,
        },
        {
          key: 'e93d6b8d6e09fdc2969a23b533d11b7bf2063b7a385ed7fed2bd5a8312688c12',
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
              key: 'e93d6b8d6e09fdc2969a23b533d11b7bf2063b7a385ed7fed2bd5a8312688c12',
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
              key: 'e93d6b8d6e09fdc2969a23b533d11b7bf2063b7a385ed7fed2bd5a8312688c12',
              seeds: ['0200', ''],
            },
          ],
          children: [
            {
              program: '0100000000000000000000000000000000000000000000000000000000000000',
              metas: [
                {
                  key: 'e93d6b8d6e09fdc2969a23b533d11b7bf2063b7a385ed7fed2bd5a8312688c12',
                  signer: true,
                  writable: false,
                },
              ],
              derived: [],
              children: [],
            },
          ],
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
          key: 'e93d6b8d6e09fdc2969a23b533d11b7bf2063b7a385ed7fed2bd5a8312688c12',
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
          key: 'e93d6b8d6e09fdc2969a23b533d11b7bf2063b7a385ed7fed2bd5a8312688c12',
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
    {
      program: '0100000000000000000000000000000000000000000000000000000000000000',
      metas: [
        {
          key: 'e93d6b8d6e09fdc2969a23b533d11b7bf2063b7a385ed7fed2bd5a8312688c12',
          signer: true,
          writable: false,
        },
      ],
    },
  ]);
  assert.deepEqual(input, original);
});
test('independent vector 4', () => {
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
        key: '8b7f58c57db3b5cb6429151b3daea9de8b54414279d01568602c1edbd575e1e8',
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
          key: '8b7f58c57db3b5cb6429151b3daea9de8b54414279d01568602c1edbd575e1e8',
          signer: false,
          writable: false,
        },
        {
          key: '8b7f58c57db3b5cb6429151b3daea9de8b54414279d01568602c1edbd575e1e8',
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
              key: '8b7f58c57db3b5cb6429151b3daea9de8b54414279d01568602c1edbd575e1e8',
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
              key: '8b7f58c57db3b5cb6429151b3daea9de8b54414279d01568602c1edbd575e1e8',
              seeds: ['0300', ''],
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
          key: '8b7f58c57db3b5cb6429151b3daea9de8b54414279d01568602c1edbd575e1e8',
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
          key: '8b7f58c57db3b5cb6429151b3daea9de8b54414279d01568602c1edbd575e1e8',
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
test('independent vector 6', () => {
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
        key: '3c6ec2711a372860bbda9ff69cccaebcfdaa91a329e4d76af0aaad8b5b2c8540',
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
          key: '3c6ec2711a372860bbda9ff69cccaebcfdaa91a329e4d76af0aaad8b5b2c8540',
          signer: false,
          writable: false,
        },
        {
          key: '3c6ec2711a372860bbda9ff69cccaebcfdaa91a329e4d76af0aaad8b5b2c8540',
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
              key: '3c6ec2711a372860bbda9ff69cccaebcfdaa91a329e4d76af0aaad8b5b2c8540',
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
              key: '3c6ec2711a372860bbda9ff69cccaebcfdaa91a329e4d76af0aaad8b5b2c8540',
              seeds: ['0500', ''],
            },
          ],
          children: [
            {
              program: '0100000000000000000000000000000000000000000000000000000000000000',
              metas: [
                {
                  key: '3c6ec2711a372860bbda9ff69cccaebcfdaa91a329e4d76af0aaad8b5b2c8540',
                  signer: true,
                  writable: false,
                },
              ],
              derived: [],
              children: [],
            },
          ],
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
          key: '3c6ec2711a372860bbda9ff69cccaebcfdaa91a329e4d76af0aaad8b5b2c8540',
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
          key: '3c6ec2711a372860bbda9ff69cccaebcfdaa91a329e4d76af0aaad8b5b2c8540',
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
    {
      program: '0100000000000000000000000000000000000000000000000000000000000000',
      metas: [
        {
          key: '3c6ec2711a372860bbda9ff69cccaebcfdaa91a329e4d76af0aaad8b5b2c8540',
          signer: true,
          writable: false,
        },
      ],
    },
  ]);
  assert.deepEqual(input, original);
});
test('independent vector 7', () => {
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
        key: '2ecb76eff9f4c92c8c12f5d64c8a9c57018c47157dc3ab604f213977ac53c079',
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
          key: '2ecb76eff9f4c92c8c12f5d64c8a9c57018c47157dc3ab604f213977ac53c079',
          signer: false,
          writable: false,
        },
        {
          key: '2ecb76eff9f4c92c8c12f5d64c8a9c57018c47157dc3ab604f213977ac53c079',
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
              key: '2ecb76eff9f4c92c8c12f5d64c8a9c57018c47157dc3ab604f213977ac53c079',
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
              key: '2ecb76eff9f4c92c8c12f5d64c8a9c57018c47157dc3ab604f213977ac53c079',
              seeds: ['0600', ''],
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
          key: '2ecb76eff9f4c92c8c12f5d64c8a9c57018c47157dc3ab604f213977ac53c079',
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
          key: '2ecb76eff9f4c92c8c12f5d64c8a9c57018c47157dc3ab604f213977ac53c079',
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
test('independent vector 8', () => {
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
        key: 'e96db7b70ae2913219f6103b2adf6f58697e1af0989ccc8e77827f4d1cf3af34',
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
          key: 'e96db7b70ae2913219f6103b2adf6f58697e1af0989ccc8e77827f4d1cf3af34',
          signer: false,
          writable: false,
        },
        {
          key: 'e96db7b70ae2913219f6103b2adf6f58697e1af0989ccc8e77827f4d1cf3af34',
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
              key: 'e96db7b70ae2913219f6103b2adf6f58697e1af0989ccc8e77827f4d1cf3af34',
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
              key: 'e96db7b70ae2913219f6103b2adf6f58697e1af0989ccc8e77827f4d1cf3af34',
              seeds: ['0700', ''],
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
          key: 'e96db7b70ae2913219f6103b2adf6f58697e1af0989ccc8e77827f4d1cf3af34',
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
          key: 'e96db7b70ae2913219f6103b2adf6f58697e1af0989ccc8e77827f4d1cf3af34',
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
test('independent vector 9', () => {
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
        key: 'aa0f97957ea1f04fb14b8cedfd3e748b1b8bf7d55303f8e0ca833ff3a31e00b5',
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
          key: 'aa0f97957ea1f04fb14b8cedfd3e748b1b8bf7d55303f8e0ca833ff3a31e00b5',
          signer: false,
          writable: false,
        },
        {
          key: 'aa0f97957ea1f04fb14b8cedfd3e748b1b8bf7d55303f8e0ca833ff3a31e00b5',
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
              key: 'aa0f97957ea1f04fb14b8cedfd3e748b1b8bf7d55303f8e0ca833ff3a31e00b5',
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
              key: 'aa0f97957ea1f04fb14b8cedfd3e748b1b8bf7d55303f8e0ca833ff3a31e00b5',
              seeds: ['0800', ''],
            },
          ],
          children: [
            {
              program: '0100000000000000000000000000000000000000000000000000000000000000',
              metas: [
                {
                  key: 'aa0f97957ea1f04fb14b8cedfd3e748b1b8bf7d55303f8e0ca833ff3a31e00b5',
                  signer: true,
                  writable: false,
                },
              ],
              derived: [],
              children: [],
            },
          ],
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
          key: 'aa0f97957ea1f04fb14b8cedfd3e748b1b8bf7d55303f8e0ca833ff3a31e00b5',
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
          key: 'aa0f97957ea1f04fb14b8cedfd3e748b1b8bf7d55303f8e0ca833ff3a31e00b5',
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
    {
      program: '0100000000000000000000000000000000000000000000000000000000000000',
      metas: [
        {
          key: 'aa0f97957ea1f04fb14b8cedfd3e748b1b8bf7d55303f8e0ca833ff3a31e00b5',
          signer: true,
          writable: false,
        },
      ],
    },
  ]);
  assert.deepEqual(input, original);
});
test('independent vector 10', () => {
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
        key: '8632fb85dbecce55861c8f381b851a458f304785d21f033e5c05a9f16df5f044',
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
          key: '8632fb85dbecce55861c8f381b851a458f304785d21f033e5c05a9f16df5f044',
          signer: false,
          writable: false,
        },
        {
          key: '8632fb85dbecce55861c8f381b851a458f304785d21f033e5c05a9f16df5f044',
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
              key: '8632fb85dbecce55861c8f381b851a458f304785d21f033e5c05a9f16df5f044',
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
              key: '8632fb85dbecce55861c8f381b851a458f304785d21f033e5c05a9f16df5f044',
              seeds: ['0900', ''],
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
          key: '8632fb85dbecce55861c8f381b851a458f304785d21f033e5c05a9f16df5f044',
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
          key: '8632fb85dbecce55861c8f381b851a458f304785d21f033e5c05a9f16df5f044',
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
test('independent vector 11', () => {
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
        key: '11f955c1d3b87e265f56d8d9070717e13b665f30428461777e9334fd533b805d',
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
          key: '11f955c1d3b87e265f56d8d9070717e13b665f30428461777e9334fd533b805d',
          signer: false,
          writable: false,
        },
        {
          key: '11f955c1d3b87e265f56d8d9070717e13b665f30428461777e9334fd533b805d',
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
              key: '11f955c1d3b87e265f56d8d9070717e13b665f30428461777e9334fd533b805d',
              signer: false,
              writable: true,
            },
            {
              key: '0900000000000000000000000000000000000000000000000000000000000000',
              signer: false,
              writable: false,
            },
          ],
          derived: [],
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
          key: '11f955c1d3b87e265f56d8d9070717e13b665f30428461777e9334fd533b805d',
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
          key: '11f955c1d3b87e265f56d8d9070717e13b665f30428461777e9334fd533b805d',
          signer: false,
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
test('independent vector 12', () => {
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
        key: 'a8c2b88925a9ca3ec938f08baaf14675d8a0748426b8aebf407f1cbccdb880e7',
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
          key: 'a8c2b88925a9ca3ec938f08baaf14675d8a0748426b8aebf407f1cbccdb880e7',
          signer: false,
          writable: false,
        },
        {
          key: 'a8c2b88925a9ca3ec938f08baaf14675d8a0748426b8aebf407f1cbccdb880e7',
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
      children: [],
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
          key: 'a8c2b88925a9ca3ec938f08baaf14675d8a0748426b8aebf407f1cbccdb880e7',
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
  ]);
  assert.deepEqual(input, original);
});
test('independent vector 13', () => {
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
        key: '9af252fe9da024228c24050674b9c6d74a376c0740e3fc36b3e2ea57b49609a1',
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
          key: '9af252fe9da024228c24050674b9c6d74a376c0740e3fc36b3e2ea57b49609a1',
          signer: false,
          writable: false,
        },
        {
          key: '9af252fe9da024228c24050674b9c6d74a376c0740e3fc36b3e2ea57b49609a1',
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
              key: '9af252fe9da024228c24050674b9c6d74a376c0740e3fc36b3e2ea57b49609a1',
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
              key: '9af252fe9da024228c24050674b9c6d74a376c0740e3fc36b3e2ea57b49609a1',
              seeds: ['0000', ''],
            },
          ],
          children: [],
        },
      ],
    },
  };
  const original = structuredClone(input);
  assert.deepEqual(solve(input), { error: 'invalid' });
  assert.deepEqual(input, original);
});
test('independent vector 14', () => {
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
        writable: false,
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
          writable: false,
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
  assert.deepEqual(solve(input), { error: 'invalid' });
  assert.deepEqual(input, original);
});
test('independent vector 15', () => {
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
      derived: [
        {
          key: '53e66062bdb455aadb02dd6dc7e6c3704ba4d15680ee7288d404c22d12472685',
          seeds: ['0000', ''],
        },
      ],
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
  assert.deepEqual(solve(input), { error: 'invalid' });
  assert.deepEqual(input, original);
});
test('independent vector 16', () => {
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
          signer: 'true',
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
  assert.deepEqual(solve(input), { error: 'invalid' });
  assert.deepEqual(input, original);
});
