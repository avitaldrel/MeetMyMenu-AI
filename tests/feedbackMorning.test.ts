import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldSendMorningReport } from '../api/cron-morning.ts';

test('feedback submissions trigger the morning report', () => {
  assert.equal(shouldSendMorningReport({ totals: { users: 0 }, website: { sessions: 1, signups: 0, feedback: 1 } }), true);
});
