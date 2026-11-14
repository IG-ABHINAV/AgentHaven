'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { createHandler, vendorOf } = require('../src/mcp');
const { start } = require('../src/server');
const wb = require('../src/workboard');

const tmpDir = (p = 'ah-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const tmpStore = (opts = {}) => new Store({ dataDir: tmpDir(), ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('leases: a quiet agent loses its claim, a heartbeat keeps it', async () => {
  // Wide margins: Windows CI spends hundreds of ms on file locks and renames alone.
  const s = tmpStore({ leaseMs: 2000 });
  const a = s.createTask({ title: 'A', files: ['src/a.js'], actor: 'x' });
  const b = s.createTask({ title: 'B', actor: 'x' });
  s.claimTask(a.id, { actor: 'claude' });
  s.claimTask(b.id, { actor: 'codex' });
  await sleep(1200); // both leases still valid (2000 ms)
  s.heartbeat({ actor: 'codex' }); // codex now runs until ~3200 ms
  await sleep(1200); // claude's lease ended at ~2000 ms; codex has ~800 ms to spare
  const after = s.getTask(a.id);
  assert.equal(after.status, 'todo');
  assert.equal(after.assignee, null);
  assert.match(after.handoffs.at(-1).summary, /Lease expired/);
  assert.equal(s.getTask(b.id).assignee, 'codex');
  assert.ok(s.activity().some((e) => e.action === 'task.lease_expired' && e.ref === a.id));
  assert.deepEqual(s.fileClaims(), []);
  assert.equal(s.claimTask(a.id, { actor: 'gemini' }).assignee, 'gemini');
});

test('dependencies: no claim before they are done, no cycles', () => {
  const s = tmpStore();
  const design = s.createTask({ title: 'Design', actor: 'x' });
  const build = s.createTask({ title: 'Build', dependsOn: [design.id], actor: 'x' });
  assert.deepEqual(s.listTasks().find((t) => t.id === build.id).waitingOn, [design.id]);
  assert.throws(() => s.claimTask(build.id, { actor: 'codex' }), /waiting on "Design"/);
  const d = s.getTask(design.id);
  assert.throws(() => s.updateTask(design.id, { version: d.version, dependsOn: [build.id], actor: 'x' }), /cycle/);
  assert.throws(() => s.createTask({ title: 'Z', dependsOn: ['task_nope'], actor: 'x' }), /not found/);
  s.updateTask(design.id, { version: d.version, status: 'done', actor: 'x' });
  assert.equal(s.claimTask(build.id, { actor: 'codex' }).status, 'doing');
});

test('next_task: priority first, skills and files respected, claims atomically', () => {
  const s = tmpStore();
  s.registerAgent({ actor: 'trainer', kind: 'neural-network', skills: ['GPU'] });
  const low = s.createTask({ title: 'Low', priority: 3, actor: 'x' });
  const gpu = s.createTask({ title: 'Train', priority: 0, skills: ['gpu'], actor: 'x' });
  const high = s.createTask({ title: 'High', priority: 'P1', files: ['src/'], actor: 'x' });
  const busy = s.createTask({ title: 'Busy', files: ['src/x.js'], actor: 'x' });
  s.claimTask(busy.id, { actor: 'gemini' });
  const forCodex = s.nextTask({ actor: 'codex' });
  assert.equal(forCodex.task.id, low.id, 'gpu task needs skills, src/ is in use');
  assert.ok(forCodex.skipped.some((r) => r.startsWith(gpu.id)));
  assert.ok(forCodex.skipped.some((r) => r.startsWith(high.id) && /gemini/.test(r)));
  const forTrainer = s.nextTask({ actor: 'trainer', claim: true });
  assert.equal(forTrainer.task.id, gpu.id);
  assert.equal(forTrainer.task.assignee, 'trainer');
  assert.ok(forTrainer.task.leaseUntil);
});

test('review: criteria and a second pair of eyes gate "done"', () => {
  const s = tmpStore();
  const t = s.createTask({ title: 'Fix', criteria: ['has test', 'docs updated'], review: true, actor: 'roel' });
  s.claimTask(t.id, { actor: 'codex' });
  let cur = s.getTask(t.id);
  assert.throws(() => s.updateTask(t.id, { version: cur.version, status: 'done', actor: 'codex' }), /criteria still open/);
  s.setCriterion(t.id, { actor: 'codex', criterion: '1', done: true });
  s.setCriterion(t.id, { actor: 'codex', criterion: 'docs updated', done: true });
  cur = s.getTask(t.id);
  assert.throws(() => s.updateTask(t.id, { version: cur.version, status: 'done', actor: 'codex' }), /review/);
  assert.throws(() => s.updateTask(t.id, { version: cur.version, status: 'done', actor: 'gemini' }), /codex holds this task/);
  s.submitForReview(t.id, { actor: 'codex', summary: 'done', verification: 'npm test: 12 passed' });
  assert.throws(() => s.reviewTask(t.id, { actor: 'codex', approve: true }), /own work/);
  assert.throws(() => s.reviewTask(t.id, { actor: 'claude', approve: false }), /comment/);
  const back = s.reviewTask(t.id, { actor: 'claude', approve: false, comment: 'add an edge case' });
  assert.equal(back.status, 'doing');
  s.submitForReview(t.id, { actor: 'codex', summary: 'edge case added', verification: 'npm test: 13 passed' });
  const ok = s.reviewTask(t.id, { actor: 'claude', approve: true, comment: 'lgtm' });
  assert.equal(ok.status, 'done');
  assert.equal(ok.reviewedBy, 'claude');
  assert.deepEqual(ok.comments.map((c) => c.kind), ['review-request', 'changes-requested', 'review-request', 'approval']);
});

test('a human may close or reassign any task', () => {
  const s = tmpStore();
  const t = s.createTask({ title: 'X', review: true, actor: 'roel' });
  s.claimTask(t.id, { actor: 'codex' });
  const cur = s.getTask(t.id);
  assert.equal(s.updateTask(t.id, { version: cur.version, status: 'done', actor: 'you' }).status, 'done');
});

test('progress: usage adds up, metrics become series, the budget blocks the task', () => {
  const s = tmpStore();
  const t = s.createTask({ title: 'Train', budget: { costUsd: 1 }, actor: 'roel' });
  assert.throws(() => s.reportProgress(t.id, { actor: 'trainer', progress: 10 }), /claim the task first/);
  s.claimTask(t.id, { actor: 'trainer' });
  s.reportProgress(t.id, { actor: 'trainer', progress: 25, usage: { costUsd: 0.6, tokens: 10 }, metrics: { loss: 1.2 } });
  const r = s.reportProgress(t.id, { actor: 'trainer', progress: 50, usage: { costUsd: 0.6 }, metrics: { loss: 0.8 } });
  assert.equal(r.status, 'blocked');
  assert.match(r.blockedReason, /Budget exceeded: \$1\.20 of \$1\.00/);
  const full = s.getTask(t.id);
  assert.deepEqual(full.metrics.loss.map((p) => p.v), [1.2, 0.8]);
  assert.equal(full.usage.tokens, 10);
  assert.deepEqual(s.listTasks()[0].metrics, { loss: 0.8 });
  assert.throws(() => s.reportProgress(t.id, { actor: 'trainer', progress: 120 }), /0\.\.100/);
  assert.throws(() => s.reportProgress(t.id, { actor: 'trainer', metrics: { loss: 'x' } }), /number/);
  assert.equal(s.stats().usage.costUsd, 1.2);
});

test('events: a cursor returns only what is new', () => {
  const s = tmpStore();
  const first = s.events({ since: 0 });
  s.createTask({ title: 'A', actor: 'x' });
  s.createTask({ title: 'B', actor: 'x' });
  const page = s.events({ since: first.cursor });
  assert.deepEqual(page.events.map((e) => e.detail), ['A', 'B']);
  assert.equal(s.events({ since: page.cursor }).events.length, 0);
});

test('paths normalise and delete needs a version', () => {
  const s = tmpStore();
  const t = s.createTask({ title: 'P', files: ['src//a.js', './src/./b.js', 'src/lib/../c.js', '.'], actor: 'x' });
  assert.deepEqual(t.files, ['src/a.js', 'src/b.js', 'src/c.js']);
  assert.throws(() => s.deleteTask(t.id, { actor: 'x' }), { code: 'INVALID' });
  const dep = s.createTask({ title: 'Q', dependsOn: [t.id], actor: 'x' });
  s.deleteTask(t.id, { version: 1, actor: 'x' });
  assert.deepEqual(s.getTask(dep.id).dependsOn, []);
});

test('listTasks: an unknown status is an error, not an empty board', async () => {
  const s = tmpStore();
  s.createTask({ title: 'a', actor: 'you' });
  assert.equal(s.listTasks().length, 1);
  assert.equal(s.listTasks({ status: '' }).length, 1);
  assert.equal(s.listTasks({ status: 'todo' }).length, 1);
  assert.equal(s.listTasks({ status: 'doing' }).length, 0);
  assert.throws(() => s.listTasks({ status: 'In Progress' }), /status must be one of todo, doing, blocked, review, done/);
  assert.throws(() => s.listTasks({ status: 'bogus' }), /status must be one of/);
  const { server, url } = await start({ store: s });
  try {
    const bad = await fetch(`${url}api/tasks?status=In%20Progress`);
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /status must be one of todo, doing, blocked, review, done/);
    assert.equal((await fetch(`${url}api/tasks?status=todo`)).status, 200);
  } finally {
    server.close();
  }
});

test('schema 1 workspace files still load', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'default.json'), `﻿${JSON.stringify({ schema: 1, tasks: [{ id: 'task_aaaaaaaaaaaa', title: 'Old', description: '', status: 'todo', assignee: null, files: [], createdBy: 'x', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', version: 1 }], notes: [], log: [{ id: 'evt_1', at: '2026-01-01T00:00:00.000Z', actor: 'x', action: 'task.created' }] })}`);
  const s = new Store({ dataDir: dir });
  const [t] = s.listTasks();
  assert.equal(t.priority, 2);
  assert.deepEqual(t.criteria, []);
  assert.equal(s.claimTask(t.id, { actor: 'codex' }).status, 'doing');
  assert.equal(s.activity()[0].seq, 2);
});

test('workboard: agents of any vendor collaborate by editing WORKBOARD.md', () => {
  const s = tmpStore();
  const dir = tmpDir('ah-wb-');
  const file = path.join(dir, wb.BOARD);
  wb.syncOnce(s, dir);
  const add = (...lines) => fs.appendFileSync(file, `${lines.join('\n')}\n`);
  add('codex: hello kind=llm vendor=OpenAI model=gpt-5 skills=python', '- gemini: hello vendor=Google',
    'codex: new P1 Add retry [files: src/fetch.js] [criteria: retries 3 times; has test] [review]', 'nonsense');
  let r = wb.syncOnce(s, dir);
  assert.deepEqual(r.results.map((x) => x.ok), [true, true, true, false]);
  const [task] = s.listTasks();
  assert.equal(task.priority, 1);
  assert.deepEqual(task.files, ['src/fetch.js']);
  assert.equal(task.criteria.length, 2);
  const short = task.id.slice(5, 10);
  add(`gemini: next`, `codex: claim ${short}`, `gemini: progress ${short} 40% halfway | tokens=1000 cost=0.02 tests=12`,
    `gemini: check ${short} 1`, `gemini: check ${short} 2`, `gemini: done ${short} retry with backoff | verified: npm test, 31 passed`, `gemini: approve ${short}`, `codex: approve ${short} nice`);
  r = wb.syncOnce(s, dir);
  assert.deepEqual(r.results.map((x) => x.ok), [true, false, true, true, true, true, false, true]);
  assert.match(r.results[1].message, /claimed by gemini/);
  assert.match(r.results[6].message, /own work/);
  const done = s.getTask(task.id);
  assert.equal(done.status, 'done');
  assert.equal(done.reviewedBy, 'codex');
  assert.equal(done.usage.costUsd, 0.02);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /## Recently done[\s\S]*Add retry/);
  assert.match(text, /\| codex \| llm \| OpenAI \/ gpt-5 \|/);
  assert.match(text, /✗ `codex: approve|✗ `gemini: approve/);
  assert.deepEqual(wb.inboxLines(text), [], 'the Inbox is emptied after a sync');
  const log = fs.readFileSync(path.join(dir, wb.LOGBOOK), 'utf8');
  assert.match(log, /\*\*codex\*\* · approved/);
  const lines = log.split('\n').length;
  wb.syncOnce(s, dir);
  assert.equal(fs.readFileSync(path.join(dir, wb.LOGBOOK), 'utf8').split('\n').length, lines, 'the logbook is append-only, no repeats');
});

test('workboard: a progress line without a valid percentage is refused with a hint', () => {
  const s = tmpStore();
  const dir = tmpDir('ah-wb-progress-');
  const file = path.join(dir, wb.BOARD);
  wb.syncOnce(s, dir);
  const add = (...lines) => fs.appendFileSync(file, `${lines.join('\n')}\n`);
  add('codex: new P1 Add retry');
  wb.syncOnce(s, dir);
  const [task] = s.listTasks();
  const short = task.id.slice(5, 10);
  add(`codex: claim ${short}`);
  wb.syncOnce(s, dir);
  const before = s.getTask(task.id);

  add(`codex: progress ${short} 50 percent tests pass`,
    `codex: progress ${short}`,
    `codex: progress ${short} -5%`,
    `codex: progress ${short} 150% too far`);
  let r = wb.syncOnce(s, dir);
  assert.deepEqual(r.results.map((x) => x.ok), [false, false, false, false]);
  for (const x of r.results.slice(0, 3)) assert.match(x.message, /write "progress <task> 40%/);
  assert.match(r.results[3].message, /0\.\.100/);
  const unchanged = s.getTask(task.id);
  assert.equal(unchanged.progress, before.progress);
  assert.equal(unchanged.progressNote, before.progressNote);
  assert.deepEqual(unchanged.metrics, before.metrics);

  add(`codex: progress ${short} 40% retry works | tokens=1 cost=0.01`,
    `codex: progress ${short} | loss=0.41`);
  r = wb.syncOnce(s, dir);
  assert.deepEqual(r.results.map((x) => x.ok), [true, true]);
  const after = s.getTask(task.id);
  assert.equal(after.progress, 40);
  assert.equal(after.progressNote, 'retry works');
  assert.equal(after.usage.tokens, 1);
  assert.equal(after.usage.costUsd, 0.01);
  assert.equal(after.metrics.loss.at(-1).v, 0.41);
});

test('workboard: parsing helpers', () => {
  assert.deepEqual(wb.parseProgress('40% epoch 4 | loss=0.5 cost=0.1 tokens=20'), { progress: 40, message: 'epoch 4', usage: { costUsd: 0.1, tokens: 20 }, metrics: { loss: 0.5 } });
  assert.throws(() => wb.parseProgress('10% | loss=abc'), /key=number/);
  const n = wb.parseNew('P0 Ship it [after: task_abc, task_def] [skills: gpu] [budget: $3] [review]');
  assert.equal(n.title, 'Ship it');
  assert.equal(n.priority, 0);
  assert.deepEqual(n.dependsOn, ['task_abc', 'task_def']);
  assert.deepEqual(n.budget, { costUsd: 3 });
  assert.equal(n.review, true);
});

test('MCP: vendor detection, next_task, progress and review tools', () => {
  const s = tmpStore();
  assert.equal(vendorOf('codex-mcp-client'), 'OpenAI');
  assert.equal(vendorOf('gemini-cli'), 'Google');
  assert.equal(vendorOf('claude-code'), 'Anthropic');
  const call = (h, name, args) => {
    const res = h({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }).result;
    return res.isError ? { error: res.content[0].text } : JSON.parse(res.content[0].text);
  };
  const codex = createHandler({ store: s });
  codex({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'codex-mcp-client', version: '1.0' } } });
  const claude = createHandler({ store: s, agent: 'claude' });
  claude({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'claude-code' } } });
  const agents = call(codex, 'list_agents', {});
  assert.equal(agents.find((a) => a.name === 'codex-mcp-client').vendor, 'OpenAI');
  assert.equal(agents.find((a) => a.name === 'claude').vendor, 'Anthropic');
  const t = call(claude, 'create_task', { title: 'Do it', review: true, criteria: ['works'] });
  const picked = call(codex, 'next_task', { claim: true });
  assert.equal(picked.task.id, t.id);
  assert.equal(call(codex, 'report_progress', { id: t.id, progress: 80, metrics: { tests: 41 } }).progress, 80);
  call(codex, 'check_criterion', { id: t.id, criterion: 1, done: true });
  call(codex, 'submit_for_review', { id: t.id, summary: 'all green', verification: 'pytest: 41 passed' });
  assert.match(call(codex, 'review_task', { id: t.id, approve: true }).error, /own work/);
  assert.equal(call(claude, 'review_task', { id: t.id, approve: true }).status, 'done');
  const ev = call(claude, 'events', { since: 0 });
  assert.ok(ev.events.some((e) => e.action === 'task.approved'));
});

test('HTTP: scripts act as themselves, progress, next, events and SSE', async () => {
  const s = tmpStore();
  const { server, url } = await start({ store: s });
  try {
    const as = (agent) => ({ 'Content-Type': 'application/json', 'X-AgentHaven-Agent': agent });
    await fetch(`${url}api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Train', skills: ['gpu'] }) });
    await fetch(`${url}api/agents`, { method: 'POST', headers: as('trainer'), body: JSON.stringify({ kind: 'neural-network', skills: ['gpu'] }) });
    const next = await (await fetch(`${url}api/tasks/next`, { method: 'POST', headers: as('trainer'), body: '{}' })).json();
    assert.equal(next.task.assignee, 'trainer');
    const prog = await fetch(`${url}api/tasks/${next.task.id}/progress`, { method: 'POST', headers: as('trainer'), body: JSON.stringify({ progress: 30, metrics: { loss: 0.7 } }) });
    assert.equal(prog.status, 201);
    const foreign = await fetch(`${url}api/tasks/${next.task.id}/progress`, { method: 'POST', headers: as('intruder'), body: JSON.stringify({ progress: 90 }) });
    assert.equal(foreign.status, 409);
    assert.equal((await fetch(`${url}api/tasks/task_nope`)).status, 404);
    assert.equal((await fetch(`${url}api/stats`, { headers: { 'X-AgentHaven-Agent': 'bad name!' } })).status, 400);
    assert.equal((await fetch(`${url}api/tasks/${next.task.id}?version=1`, { method: 'DELETE', headers: as('x') })).status, 409);
    const ev = await (await fetch(`${url}api/events?since=0`)).json();
    assert.ok(ev.events.some((e) => e.action === 'task.progress' && e.actor === 'trainer'));
    const ctrl = new AbortController();
    const res = await fetch(`${url}api/stream`, { signal: ctrl.signal });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const reader = res.body.getReader();
    const { value } = await reader.read();
    assert.match(Buffer.from(value).toString(), /event: change/);
    ctrl.abort();
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('HTTP: linking a folder shares the board as files', async () => {
  const s = tmpStore();
  const dir = tmpDir('ah-link-');
  const { server, url } = await start({ store: s });
  try {
    const json = { 'Content-Type': 'application/json' };
    assert.equal((await fetch(`${url}api/workboard`, { method: 'POST', headers: json, body: JSON.stringify({ dir: 'relative/path' }) })).status, 400);
    const linked = await (await fetch(`${url}api/workboard`, { method: 'POST', headers: json, body: JSON.stringify({ dir }) })).json();
    assert.equal(linked.linked, true);
    assert.match(linked.instructions, /WORKBOARD\.md/);
    fs.appendFileSync(path.join(dir, wb.BOARD), 'aider: new Write the changelog\n');
    for (let i = 0; i < 40 && !s.listTasks().length; i++) await sleep(100);
    assert.equal(s.listTasks()[0]?.title, 'Write the changelog');
    assert.equal((await (await fetch(`${url}api/workboard`, { method: 'DELETE' })).json()).linked, false);
  } finally {
    server.close();
  }
});

test('connect: Gemini CLI (JSON) and Codex (TOML) keep their other settings', () => {
  const connect = require('../src/connect');
  const home = tmpDir('ah-home-');
  const opts = { home, platform: 'linux', env: {} };
  const entry = connect.serverEntry({ command: '/app', script: '/app/bin/agenthaven.js', agent: 'codex', extraEnv: { ELECTRON_RUN_AS_NODE: '1' } });
  const toml = connect.clients(opts).codex.file;
  fs.mkdirSync(path.dirname(toml), { recursive: true });
  fs.writeFileSync(toml, 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n');
  connect.install('codex', entry, opts);
  connect.install('codex', entry, opts);
  const text = fs.readFileSync(toml, 'utf8');
  assert.match(text, /^model = "gpt-5"/);
  assert.match(text, /\[mcp_servers\.other\]\ncommand = "x"/);
  assert.equal(text.match(/\[mcp_servers\.agenthaven\]/g).length, 1);
  assert.match(text, /args = \["\/app\/bin\/agenthaven.js", "mcp", "--agent", "codex", "--workspace", "default"\]/);
  assert.match(text, /env = \{ ELECTRON_RUN_AS_NODE = "1" \}/);
  connect.install('gemini', entry, opts);
  assert.ok(JSON.parse(fs.readFileSync(connect.clients(opts).gemini.file, 'utf8')).mcpServers.agenthaven);
});

test('workboard: backslashes and pipes in text cannot break the tables', () => {
  const s = tmpStore();
  s.createTask({ title: 'C:\\path\\ | weird \\| title', actor: 'x' });
  const t = s.listTasks()[0];
  s.claimTask(t.id, { actor: 'codex' });
  const md = wb.renderBoard(s);
  const row = md.split('\n').find((l) => l.includes(t.id) && l.startsWith('|'));
  assert.ok(row.includes('C:\\\\path\\\\ \\| weird \\\\\\| title'), row);
  assert.equal(row.split(/(?<!\\)\|/).length - 2, 7, 'still seven columns');
});

test('dreaming: past mistakes become lessons that reach the next agent', async () => {
  const dreams = require('../src/dream');
  const s = tmpStore();
  // Only the renderer task gets a short lease, so slow machines cannot expire the other claims.
  const fast = new Store({ dataDir: s.dataDir, leaseMs: 30 });
  // Two reviews in src/api sent back for the same reason.
  for (const n of [1, 2]) {
    const t = s.createTask({ title: `Endpoint ${n}`, files: [`src/api/e${n}.js`], review: true, actor: 'roel' });
    s.claimTask(t.id, { actor: 'codex' });
    s.submitForReview(t.id, { actor: 'codex', summary: 'done', verification: 'ran the endpoint tests' });
    s.reviewTask(t.id, { actor: 'claude', approve: false, comment: 'missing input validation tests' });
  }
  // A task whose claims keep expiring.
  const big = s.createTask({ title: 'Rewrite the renderer', actor: 'roel' });
  fast.claimTask(big.id, { actor: 'gemini' });
  await sleep(80);
  fast.claimTask(big.id, { actor: 'gemini' });
  await sleep(80);
  s.listTasks();
  // Two notes that say the same thing.
  s.addNote({ title: 'Paths', body: 'Always store paths with forward slashes in the store', actor: 'a' });
  s.addNote({ title: 'Paths again', body: 'Always store paths with forward slashes in the store please', actor: 'b' });

  const d = dreams.dream(s);
  const kinds = [...new Set(d.proposals.map((p) => p.kind))].sort();
  assert.deepEqual(kinds, ['agent-tip', 'lesson', 'merge-notes', 'task']);
  // gemini went quiet twice on the renderer.
  assert.deepEqual(d.proposals.filter((p) => p.kind === 'agent-tip').map((p) => p.agent), ['gemini']);
  const lesson = d.proposals.find((p) => p.kind === 'lesson');
  assert.match(lesson.title, /src\/api was sent back 2 times/);
  assert.match(lesson.body, /missing input validation tests/);
  assert.deepEqual(lesson.scope.files, ['src/api']);
  assert.ok(d.proposals.every((p) => p.status === 'proposed'), 'nothing changes without review');

  assert.throws(() => dreams.applyProposal(s, lesson.id, { actor: 'codex' }), /only a human/);
  dreams.applyProposal(s, lesson.id, { actor: 'you' });
  const split = d.proposals.find((p) => p.kind === 'task');
  assert.match(dreams.applyProposal(s, split.id, { actor: 'you' }).ref, /^task_/);
  dreams.applyProposal(s, d.proposals.find((p) => p.kind === 'merge-notes').id, { actor: 'you' });
  assert.equal(s.listNotes().filter((n) => n.title.startsWith('Paths')).length, 1);
  for (const tip of d.proposals.filter((p) => p.kind === 'agent-tip')) dreams.dismissProposal(s, tip.id, { actor: 'you', reason: 'known' });

  // The next agent working in src/api gets the lesson.
  const next = s.createTask({ title: 'Endpoint 3', files: ['src/api/e3.js'], actor: 'roel' });
  assert.equal(dreams.lessonsFor(s, s.getTask(next.id))[0].title, lesson.title);
  assert.deepEqual(dreams.lessonsFor(s, s.createTask({ title: 'Unrelated docs', files: ['docs/x.md'], actor: 'roel' })), []);
  assert.match(wb.renderBoard(s), /## Lessons learned[\s\S]*src\/api was sent back/);

  // A second dream sees nothing new and does not repeat itself.
  assert.equal(dreams.dream(s).proposals.length, 0);
});

test('dreaming: an LLM dreamer (e.g. Claude) works through MCP; auto-apply skips review', () => {
  const dreams = require('../src/dream');
  const s = tmpStore();
  const h = createHandler({ store: s, agent: 'claude-dreamer' });
  const call = (name, args) => {
    const res = h({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }).result;
    return res.isError ? { error: res.content[0].text } : JSON.parse(res.content[0].text);
  };
  s.createTask({ title: 'Seed', actor: 'roel' });
  const dg = call('dream_digest', {});
  assert.ok(dg.until > 0 && Array.isArray(dg.sentBack) && dg.guide);
  assert.match(call('submit_dream', { summary: 'x', proposals: [{ kind: 'retire-note', title: 'r', body: 'b', note: 'note_missing' }] }).error, /not found/);
  const d = call('submit_dream', { summary: 'Handoffs leave out how to run the tests.', proposals: [
    { kind: 'lesson', title: 'Say how to run the tests in every handoff', body: 'Write the exact command.', scope: { skills: ['python'] }, evidence: [] }] });
  assert.equal(d.by, 'claude-dreamer');
  assert.equal(d.proposals[0].status, 'proposed');
  assert.equal(call('dream_digest', {}).openProposals.length, 1);
  dreams.setDreamSettings(s, { autoApply: true });
  const auto = call('submit_dream', { summary: 'y', proposals: [{ kind: 'lesson', title: 'Pin tool versions in CI', body: 'Unpinned versions broke CI twice.' }] });
  assert.equal(auto.proposals[0].status, 'applied');
  const t = call('create_task', { title: 'Add a parser', skills: ['python'] });
  const got = call('get_task', { id: t.id });
  assert.deepEqual(got.lessons.map((l) => l.title), []);
  dreams.applyProposal(s, d.proposals[0].id, { actor: 'you' });
  assert.equal(call('get_task', { id: t.id }).lessons[0].title, 'Say how to run the tests in every handoff');
  assert.match(dreams.CLAUDE_DREAMER, /submit_dream/);
});

test('HTTP: dream now, review proposals, settings', async () => {
  const s = tmpStore();
  const { server, url } = await start({ store: s });
  try {
    const json = { 'Content-Type': 'application/json' };
    s.addNote({ title: 'Tabs', body: 'Indent with two spaces everywhere in this repository', actor: 'a' });
    s.addNote({ title: 'Indent', body: 'Indent with two spaces everywhere in this repository!', actor: 'b' });
    const d = await (await fetch(`${url}api/dreams`, { method: 'POST', headers: json, body: '{}' })).json();
    assert.equal(d.proposals[0].kind, 'merge-notes');
    const asAgent = await fetch(`${url}api/dreams/proposals/${d.proposals[0].id}/apply`, { method: 'POST', headers: { ...json, 'X-AgentHaven-Agent': 'codex' }, body: '{}' });
    assert.equal(asAgent.status, 409);
    assert.equal((await fetch(`${url}api/dreams/proposals/${d.proposals[0].id}/apply`, { method: 'POST', headers: json, body: '{}' })).status, 201);
    const set = await (await fetch(`${url}api/dreams/settings`, { method: 'PATCH', headers: json, body: JSON.stringify({ everyHours: 12, autoApply: true }) })).json();
    assert.deepEqual(set, { autoApply: true, everyHours: 12, agentTask: false });
    const list = await (await fetch(`${url}api/dreams`)).json();
    assert.equal(list.dreams[0].proposals[0].status, 'applied');
    assert.match((await (await fetch(`${url}api/dreams/prompt`)).json()).prompt, /dreaming agent/);
  } finally {
    server.close();
  }
});

test('collaboration without humans: three vendors finish a goal on their own', () => {
  const s = tmpStore();
  const mcp = (agent, client) => {
    const h = createHandler({ store: s, agent });
    h({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { clientInfo: { name: client } } });
    return (name, args = {}) => {
      const res = h({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }).result;
      return res.isError ? { error: res.content[0].text } : JSON.parse(res.content[0].text);
    };
  };
  const claude = mcp('claude', 'claude-code');
  const codex = mcp('codex', 'codex-mcp-client');
  const gemini = mcp('gemini', 'gemini-cli');
  gemini('register_agent', { skills: ['review', 'docs'] });
  codex('register_agent', { skills: ['python', 'review'] });

  // No human ever: agents-only is on by itself, and an agent can take the lead.
  assert.equal(claude('board_summary').agentsOnly, true);
  assert.equal(claude('take_lead').lead, 'claude');
  assert.match(codex('take_lead').error, /claude is the lead and online/);
  claude('set_goal', { text: 'Ship the CSV importer', doneWhen: 'import works and is reviewed' });
  assert.match(codex('inbox').messages.map((m) => m.body).join(' '), /New goal: Ship the CSV importer/);

  // The lead splits the work; subtasks run in order.
  const epic = claude('create_task', { title: 'CSV importer', review: false });
  const split = claude('split_task', { id: epic.id, sequential: true, parts: [{ title: 'Parser', skills: ['python'] }, { title: 'Docs', skills: ['docs'] }] });
  const [parser, docs] = split.subtasks;
  assert.deepEqual(docs.dependsOn, [parser.id]);

  // codex is unsure and asks instead of guessing; its task waits for the answer.
  assert.equal(codex('next_task', { claim: true }).task.id, parser.id);
  codex('ask_question', { id: parser.id, to: 'claude', question: 'Semicolons or commas?' });
  assert.equal(codex('get_task', { id: parser.id }).status, 'blocked');
  const q = claude('inbox').questions;
  assert.equal(q[0].text, 'Semicolons or commas?');
  claude('answer_question', { id: parser.id, answer: 'Both, detect it from the header' });
  assert.equal(codex('get_task', { id: parser.id }).status, 'doing');
  assert.equal(codex('inbox').answers[0].answer, 'Both, detect it from the header');

  // Verification is required; a reviewer with the "review" skill is picked, not the author.
  assert.match(codex('submit_for_review', { id: parser.id, summary: 'done' }).error, /verification/);
  const submitted = codex('submit_for_review', { id: parser.id, summary: 'parser done', verification: 'pytest tests/test_csv.py: 14 passed' });
  assert.equal(submitted.reviewer, 'gemini');
  assert.equal(gemini('inbox').reviews[0].id, parser.id);
  assert.equal(gemini('review_task', { id: parser.id, approve: true }).status, 'done');

  // The parent cannot close before its subtasks; context carries what the parser delivered.
  assert.match(claude('update_task', { id: epic.id, version: claude('get_task', { id: epic.id }).version, status: 'done' }).error, /subtask/);
  const ctx = gemini('get_context', { id: docs.id });
  assert.equal(ctx.dependencies[0].verification, 'pytest tests/test_csv.py: 14 passed');
  assert.equal(ctx.parent.id, epic.id);
  assert.equal(ctx.goal.text, 'Ship the CSV importer');
  gemini('claim_task', { id: docs.id });
  gemini('comment_task', { id: docs.id, body: '@codex which flag turns on semicolons?' });
  assert.ok(codex('inbox').messages.some((m) => m.kind === 'mention' && /which flag/.test(m.body)));
  gemini('update_task', { id: docs.id, version: gemini('get_task', { id: docs.id }).version, status: 'done' });

  // The lead closes the epic; the board says the goal is reached.
  claude('update_task', { id: epic.id, version: claude('get_task', { id: epic.id }).version, status: 'done' });
  const sum = codex('board_summary');
  assert.equal(sum.complete, true);
  assert.match(sum.next, /stop/);
  assert.equal(codex('next_task', {}).goalComplete, true);
});

test('loops are escalated: review ping-pong and handoff bounces', () => {
  const s = tmpStore();
  s.registerAgent({ actor: 'gemini', skills: ['review'] });
  const t = s.createTask({ title: 'Disputed', review: true, actor: 'x' });
  s.claimTask(t.id, { actor: 'codex' });
  for (let i = 0; i < 3; i++) {
    s.submitForReview(t.id, { actor: 'codex', summary: `try ${i}`, verification: 'tests' });
    s.reviewTask(t.id, { actor: 'gemini', approve: false, comment: 'not what I meant' });
  }
  const e = s.getTask(t.id);
  assert.match(e.escalated.reason, /sent back in review 3 times/);
  assert.ok(e.priority <= 1);
  assert.equal(s.inbox({ actor: 'you' }).escalations[0].id, t.id);
  assert.throws(() => s.resolveEscalation(t.id, { actor: 'codex' }), /only a human or the lead/);
  assert.equal(s.resolveEscalation(t.id, { actor: 'you', note: 'clarified the spec' }).escalated, null);

  const b = s.createTask({ title: 'Hot potato', actor: 'x' });
  s.claimTask(b.id, { actor: 'a' });
  s.handoff(b.id, { actor: 'a', to: 'b', summary: 'yours' });
  for (let i = 0; i < 3; i++) {
    s.handoff(b.id, { actor: 'b', to: 'a', summary: 'no, yours' });
    s.handoff(b.id, { actor: 'a', to: 'b', summary: 'no, yours' });
  }
  assert.match(s.getTask(b.id).escalated.reason, /handed back and forth/);
});

test('handoff to a skill reaches the least busy agent online with it', () => {
  const s = tmpStore();
  s.registerAgent({ actor: 'py1', skills: ['python'] });
  s.registerAgent({ actor: 'py2', skills: ['python'] });
  const busy = s.createTask({ title: 'Busy', actor: 'x' });
  s.claimTask(busy.id, { actor: 'py1' });
  const t = s.createTask({ title: 'Port it', actor: 'x' });
  s.claimTask(t.id, { actor: 'claude' });
  const h = s.handoff(t.id, { actor: 'claude', to: 'skill:python', summary: 'needs Python', nextSteps: 'port utils.js' });
  assert.equal(h.assignee, 'py2');
  assert.match(s.inbox({ actor: 'py2' }).messages[0].body, /Handed "Port it" to you/);
  const t2 = s.createTask({ title: 'Rust it', actor: 'x' });
  s.claimTask(t2.id, { actor: 'claude' });
  const h2 = s.handoff(t2.id, { actor: 'claude', to: 'skill:rust', summary: 'needs Rust' });
  assert.equal(h2.assignee, null);
  assert.deepEqual(h2.skills, ['rust']);
});

test('two reviewers can be required; a human or the lead closes with one', () => {
  const s = tmpStore();
  const t = s.createTask({ title: 'Security fix', review: true, reviewsRequired: 2, actor: 'x' });
  s.claimTask(t.id, { actor: 'codex' });
  s.submitForReview(t.id, { actor: 'codex', summary: 'fixed', verification: 'exploit no longer works', reviewer: 'claude' });
  assert.equal(s.reviewTask(t.id, { actor: 'claude', approve: true }).status, 'review');
  assert.throws(() => s.reviewTask(t.id, { actor: 'claude', approve: true }), /already approved/);
  const done = s.reviewTask(t.id, { actor: 'gemini', approve: true });
  assert.equal(done.status, 'done');
  assert.equal(done.reviewedBy, 'claude, gemini');
});

test('workboard: inbox, questions, messages, split, lead and goal by file', () => {
  const s = tmpStore();
  const dir = tmpDir('ah-wb2-');
  const file = path.join(dir, wb.BOARD);
  wb.syncOnce(s, dir);
  const run = (...lines) => { fs.appendFileSync(file, `${lines.join('\n')}\n`); return wb.syncOnce(s, dir).results; };
  run('aider: hello vendor=open-source skills=python', 'copilot: hello vendor=GitHub skills=review');
  let r = run('aider: lead', 'aider: goal Release 1.0 | done when: tagged and published', 'aider: new P1 Big refactor');
  assert.deepEqual(r.map((x) => x.ok), [true, true, true]);
  const big = s.listTasks()[0].id.slice(5, 11);
  r = run(`aider: split ${big} seq Extract module; Update callers`);
  assert.ok(r[0].ok, r[0].message);
  const sub = s.listTasks().find((t) => t.title === 'Extract module').id.slice(5, 11);
  r = run(`copilot: claim ${sub}`, `copilot: ask ${sub} @aider keep the old export?`, 'copilot: msg @everyone pausing the CI job for an hour');
  assert.deepEqual(r.map((x) => x.ok), [true, true, true]);
  let text = fs.readFileSync(file, 'utf8');
  assert.match(text, /\*\*Goal:\*\* Release 1\.0 — \*\*done when:\*\* tagged and published/);
  assert.match(text, /## Questions waiting for an answer[\s\S]*copilot\*\* asks @aider: keep the old export\?/);
  assert.match(text, /aider ★ lead/);
  r = run('aider: inbox', `aider: answer ${sub} yes, re-export it`, `copilot: done ${sub} extracted | verified: unit tests green`);
  assert.match(r[0].message, /keep the old export/);
  assert.ok(r[1].ok && r[2].ok, JSON.stringify(r));
  text = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /## Questions waiting/);
});

test('setMode only accepts a real boolean, so a typo cannot flip agents-only mode (#73)', () => {
  const s = tmpStore();
  const initial = s.stats().agentsOnly;
  for (const bad of [undefined, null, 'false', 'true', 0, 1, {}, []]) {
    assert.throws(() => s.setMode({ actor: 'you', agentsOnly: bad }),
      (err) => err.code === 'INVALID' && /agentsOnly must be true or false/.test(err.message),
      `refused ${JSON.stringify(bad)}`);
  }
  assert.equal(s.stats().agentsOnly, initial, 'a refused call leaves the mode untouched');
  assert.equal(s.setMode({ actor: 'you', agentsOnly: true }).agentsOnly, true);
  assert.equal(s.stats().agentsOnly, true);
  assert.equal(s.setMode({ actor: 'you', agentsOnly: false }).agentsOnly, false);
  assert.equal(s.stats().agentsOnly, false);
  assert.equal(s.activity().filter(e => e.action === 'settings.updated').length, 2,
    'only the two valid calls were logged');
});
