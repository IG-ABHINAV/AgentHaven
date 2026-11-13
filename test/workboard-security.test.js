'use strict';
// Exercise the WORKBOARD.md Inbox route, not only the Store methods behind it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const wb = require('../src/workboard');

function board() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-inbox-security-'));
  const store = new Store({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ah-store-')) });
  const file = path.join(dir, wb.BOARD);
  wb.syncOnce(store, dir);
  const run = (...commands) => {
    fs.appendFileSync(file, `${commands.join('\n')}\n`);
    return wb.syncOnce(store, dir).results;
  };
  return { store, run };
}

test('Inbox review requires verification; reject requires a reason and a different reviewer', () => {
  const { store, run } = board();
  store.registerAgent({ actor: 'reviewer', skills: ['review'] });
  const task = store.createTask({ title: 'Audit permission boundaries', review: true, actor: 'lead' });
  store.claimTask(task.id, { actor: 'worker' });
  const short = task.id.slice(5, 11);

  let results = run(`worker: review ${short} ready`);
  assert.equal(results[0].ok, false);
  assert.match(results[0].message, /verif/i);
  assert.equal(store.getTask(task.id).status, 'doing');

  results = run(`worker: review ${short} ready | verified: security checks passed`);
  assert.equal(results[0].ok, true, results[0].message);
  assert.equal(store.getTask(task.id).status, 'review');
  assert.notEqual(store.getTask(task.id).reviewer, 'worker');

  results = run(`worker: approve ${short}`, `reviewer: reject ${short}`);
  assert.deepEqual(results.map((r) => r.ok), [false, false]);
  assert.match(results[0].message, /own work/);
  assert.match(results[1].message, /comment/i);
  assert.equal(store.getTask(task.id).status, 'review');

  results = run(`reviewer: reject ${short} missing permission test`);
  assert.equal(results[0].ok, true, results[0].message);
  assert.equal(store.getTask(task.id).status, 'doing');
  assert.equal(store.getTask(task.id).assignee, 'worker');
});

test('Inbox resolve refuses a non-lead actor and permits the lead', () => {
  const { store, run } = board();
  store.registerAgent({ actor: 'reviewer', skills: ['review'] });
  const task = store.createTask({ title: 'Disputed security patch', review: true, actor: 'creator' });
  store.claimTask(task.id, { actor: 'worker' });
  for (let round = 0; round < 3; round++) {
    store.submitForReview(task.id, { actor: 'worker', summary: 'fixed', verification: 'tests pass' });
    store.reviewTask(task.id, { actor: 'reviewer', approve: false, comment: 'needs another check' });
  }
  assert.ok(store.getTask(task.id).escalated);
  const short = task.id.slice(5, 11);
  let results = run(`outsider: resolve ${short} override`);
  assert.equal(results[0].ok, false);
  assert.match(results[0].message, /only a human or the lead/i);
  assert.ok(store.getTask(task.id).escalated);

  results = run('leadagent: lead', `leadagent: resolve ${short} reviewed by lead`);
  assert.deepEqual(results.map((r) => r.ok), [true, true]);
  assert.equal(store.getTask(task.id).escalated, null);
});
