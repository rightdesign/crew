import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProjectsReport, formatProjectsReport } from '../src/projects-cmd.ts';

test('projects report marks the current area and carries prefix and mode', async () => {
  const report = await buildProjectsReport([{ route: 'issues', areaId: 'b' }], () => ({
    projectRowsWithModes: async () => [
      { id: 'a', name: 'Crew', issue_prefix: 'CREW', mode: 'automatic' },
      { id: 'b', name: 'Crew macOS', mode: 'hybrid' },
      { id: 'c', mode: 'manual' },
    ],
  }));
  assert.deepEqual(report, [{
    route: 'issues', areaId: 'b',
    projects: [
      { id: 'a', name: 'Crew', issuePrefix: 'CREW', workMode: 'automatic', current: false },
      { id: 'b', name: 'Crew macOS', issuePrefix: null, workMode: 'hybrid', current: true },
      { id: 'c', name: 'c', issuePrefix: null, workMode: 'manual', current: false },
    ],
  }]);
  assert.match(formatProjectsReport(report), /\* Crew macOS\t-\thybrid\tb/);
});

test('a failing route reports an error without hiding the others', async () => {
  const report = await buildProjectsReport([{ route: 'bad' }, { route: 'ok', areaId: 'x' }], (route) => ({
    projectRowsWithModes: async () => {
      if (route === 'bad') throw new Error('401 invalid key');
      return [{ id: 'x', name: 'X', mode: 'automatic' }];
    },
  }));
  assert.deepEqual(report[0], { route: 'bad', areaId: null, error: '401 invalid key' });
  assert.ok('projects' in report[1]!);
});
