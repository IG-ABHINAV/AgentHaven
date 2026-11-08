'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const notify = require('../src/notify');

const tmpStore = () => new Store({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ah-notify-')) });
const notesOf = (s, since = 0) => notify.pick(s.events({ since, limit: 500 }).events, notify.forStore(s.read()));

test('notify: questions and messages to a person notify, agent-to-agent traffic does not', () => {
  const s = tmpStore();
  const t = s.createTask({ title: 'Fix login', actor: 'you' });
  s.claimTask(t.id, { actor: 'claude' });
  s.askQuestion(t.id, { actor: 'claude', to: 'codex', question: 'Which branch?' });
  s.askQuestion(t.id, { actor: 'claude', to: 'humans', question: 'May I change the schema?' });
  s.sendMessage({ actor: 'codex', to: 'claude', body: 'main' });
  s.sendMessage({ actor: 'codex', to: 'you', body: 'Tests are flaky on Windows' });
  s.sendMessage({ actor: 'you', to: 'humans', body: 'note to self' });
  const n = notesOf(s);
  assert.equal(n.length, 2);
  assert.equal(n[0].title, 'claude has a question');
  assert.match(n[0].body, /"Fix login": May I change the schema\?/);
  assert.equal(n[0].taskId, t.id);
  assert.equal(n[1].title, 'Message from codex');
  assert.equal(n[1].taskId, null);
});

test('notify: a review notifies only when a person reviews it', () => {
  const s = tmpStore();
  const mine = s.createTask({ title: 'Mine', reviewer: 'you', actor: 'you' });
  const theirs = s.createTask({ title: 'Theirs', reviewer: 'codex', actor: 'you' });
  for (const t of [mine, theirs]) {
    s.claimTask(t.id, { actor: 'claude' });
    s.submitForReview(t.id, { actor: 'claude', summary: 'done', verification: 'npm test' });
  }
  const n = notesOf(s);
  assert.deepEqual(n.map((x) => x.title), ['Review ready']);
  assert.equal(n[0].taskId, mine.id);
});

test('notify: an exceeded budget always notifies, and the cursor keeps it to once', () => {
  const s = tmpStore();
  const t = s.createTask({ title: 'Train model', budget: { tokens: 100 }, actor: 'you' });
  s.claimTask(t.id, { actor: 'claude' });
  s.reportProgress(t.id, { actor: 'claude', progress: 10, usage: { tokens: 500 } });
  const first = notesOf(s);
  assert.equal(first.length, 1);
  assert.equal(first[0].title, 'Budget reached');
  assert.deepEqual(notesOf(s, first[0].seq), []);
});

test('notify: escalations notify, a person\'s own steps never do, long text is clipped', () => {
  const ev = [
    { seq: 1, actor: 'agenthaven', action: 'task.escalated', ref: 'T1', detail: 'ping-pong between two agents' },
    { seq: 2, actor: 'you', action: 'task.escalated', ref: 'T1', detail: 'x' },
    { seq: 3, actor: 'bot', action: 'message.sent', ref: null, detail: { to: 'humans', body: 'a'.repeat(500) } },
    { seq: 4, actor: 'bot', action: 'task.claimed', ref: 'T1', detail: 'x' },
  ];
  const n = notify.pick(ev, { taskOf: (id) => (id === 'T1' ? { id, title: 'Deploy' } : null) });
  assert.equal(n.length, 2);
  assert.equal(n[0].body, '"Deploy": ping-pong between two agents');
  assert.equal(n[1].body.length, 160);
  assert.ok(n[1].body.endsWith('…'));
});
