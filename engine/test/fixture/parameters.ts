// Parameter sets for the self-test: a test with `parameters: worklist search` runs once per row.
import type { ParameterSet } from '../../src/index.ts';

export const parameters: Record<string, ParameterSet> = {
  'worklist search': {
    description: 'A surname typed into the worklist search, and the patient it finds',
    rows: () => [
      { search: 'Kostova', patient: 'Ivana Kostova' },
      { search: 'Petrova', patient: 'Ana Petrova' },
    ],
    key: (row) => String(row.search),
  },
};
