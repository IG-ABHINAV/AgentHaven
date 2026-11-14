'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync, spawn, spawnSync } = require('node:child_process');
const { promisify } = require('node:util');
const { Store } = require('../src/store');
const { createHandler, PROFILES, TOOLS } = require('../src/mcp');
const { start } = require('../src/server');

const tmpStore = () => new Store({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ah-')) });

test('CLI version aliases print the package version', () => {
  const cli = path.join(__dirname, '..', 'bin', 'agenthaven.js');
  const { version } = require('../package.json');
  for (const arg of ['--version', '-v', 'version']) {
    const output = execFileSync(process.execPath, [cli, arg], { cwd: os.tmpdir(), encoding: 'utf8' });
    assert.equal(output.trim(), version, arg);
  }
});

test('CLI status prints a short summary of the board', () => {
  const cli = path.join(__dirname, '..', 'bin', 'agenthaven.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-status-'));
  const s = new Store({ dataDir: home });
  s.setGoal({ actor: 'you', text: 'Ship the release', doneWhen: 'lint and tests pass' });
  s.createTask({ title: 'Write docs', actor: 'you' });
  const bug = s.createTask({ title: 'Fix retry bug', actor: 'you' });
  s.claimTask(bug.id, { actor: 'claude' });
  s.askQuestion(bug.id, { actor: 'claude', to: 'humans', question: 'Which runner should CI use?' });
  const ship = s.createTask({ title: 'Ship v1', actor: 'you' });
  const claimed = s.claimTask(ship.id, { actor: 'codex' });
  s.updateTask(ship.id, { version: claimed.version, status: 'review', actor: 'codex' });
  const env = { ...process.env, AGENTHAVEN_HOME: home, AGENTHAVEN_WORKSPACE: 'default' };
  const out = execFileSync(process.execPath, [cli, 'status'], { cwd: os.tmpdir(), encoding: 'utf8', env });
  assert.match(out, /Goal: Ship the release \(done when: lint and tests pass\)/);
  assert.match(out, /Board: 1 to do, 0 doing, 1 blocked, 1 in review, 0 done\./);
  assert.match(out, /claude → "Fix retry bug" \(blocked\)/);
  assert.match(out, /codex → "Ship v1" \(review\)/);
  assert.match(out, /question to humans: Which runner should CI use\?/);
  assert.match(out, /"Ship v1" — in review/);
  const help = execFileSync(process.execPath, [cli, 'help'], { cwd: os.tmpdir(), encoding: 'utf8', env });
  assert.match(help, /agenthaven status/);
});

test('CLI tools lists profiles and describes a selected profile', () => {
  const cli = path.join(__dirname, '..', 'bin', 'agenthaven.js');
  const run = (...args) => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' }).trimEnd();

  const profiles = Object.fromEntries(run('tools').split(/\r?\n/).map((line) => {
    const [name] = line.split(/\s+/, 1);
    return [name, line.slice(name.length).trim().split(', ')];
  }));
  assert.deepEqual(profiles, PROFILES);

  const tools = PROFILES.code.map((name) => TOOLS.find((tool) => tool.name === name));
  assert.deepEqual(run('tools', 'code').split(/\r?\n/),
    tools.map(({ name, description }) => `${name}: ${description}`));
  assert.match(run('--help'), /agenthaven tools\s+\[profile\]/);
});

test('CLI tools rejects unknown profiles', () => {
  const cli = path.join(__dirname, '..', 'bin', 'agenthaven.js');
  for (const profile of ['unknown-profile', 'constructor']) {
    const result = spawnSync(process.execPath, [cli, 'tools', profile], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, new RegExp(`Unknown tool profile: ${profile}`));
  }
});

test('CLI prints one line for mistakes a person can fix, and a stack for real bugs', () => {
  const cli = path.join(__dirname, '..', 'bin', 'agenthaven.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-cli-errors-'));
  const env = { ...process.env, AGENTHAVEN_HOME: home, AGENTHAVEN_WORKSPACE: 'default', AGENTHAVEN_DEBUG: '' };
  const run = (args, extra = {}) => spawnSync(process.execPath, [cli, ...args], {
    cwd: os.tmpdir(), encoding: 'utf8', env: { ...env, ...extra },
  });
  const cases = [
    [['radar'], /no repository set/],
    [['repo', fs.mkdtempSync(path.join(os.tmpdir(), 'ah-notgit-'))], /not a git repository/],
    [['status', '--workspace', '../evil'], /invalid workspace name/],
    [['connect', '--off', 'nope'], /unknown client nope/],
    [['mcp', '--tools', 'bogus'], /Unknown tool profile: bogus/],
    [['serve', '--port', 'abc'], /--port must be a number from 0 to 65535/],
  ];
  for (const [args, message] of cases) {
    const label = args.join(' ');
    const r = run(args);
    assert.equal(r.status, 1, `${label}: exit 1`);
    assert.equal(r.stdout, '', `${label}: nothing on stdout`);
    assert.match(r.stderr, message, `${label}: the useful message`);
    assert.equal(r.stderr.trimEnd().split('\n').length, 1, `${label}: one line on stderr`);
    assert.doesNotMatch(r.stderr, /\bat /, `${label}: no stack frame`);
  }
  // A real bug still gives enough detail to report it.
  const badFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-badhome-')), 'not-a-dir');
  fs.writeFileSync(badFile, 'x');
  const realBug = run(['status'], { AGENTHAVEN_HOME: badFile });
  assert.equal(realBug.status, 1);
  assert.match(realBug.stderr, /\bat /, 'an unexpected error keeps its stack trace');
  const debug = run(['radar'], { AGENTHAVEN_DEBUG: '1' });
  assert.equal(debug.status, 1);
  assert.match(debug.stderr, /ValidationError: no repository set/);
  assert.match(debug.stderr, /\bat /, 'AGENTHAVEN_DEBUG=1 shows the stack for a fixable error too');
});

test('CLI connect --off requires a client before changing configuration', () => {
  const cli = path.join(__dirname, '..', 'bin', 'agenthaven.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-connect-off-'));
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'appdata'),
    XDG_CONFIG_HOME: path.join(home, 'config'),
    CODEX_HOME: path.join(home, 'codex'),
    AGENTHAVEN_HOME: path.join(home, 'board'),
    AGENTHAVEN_WORKSPACE: 'default',
  };
  const config = path.join(home, '.claude.json');
  fs.writeFileSync(config, '{}\n');
  const run = (...args) => spawnSync(process.execPath, [cli, 'connect', ...args], { cwd: home, encoding: 'utf8', env });

  for (const args of [['--off'], ['--off', '--list']]) {
    const result = run(...args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /usage: agenthaven connect --off <client>/);
    assert.match(result.stderr, /claude-code.*cursor.*codex/);
    assert.equal(fs.readFileSync(config, 'utf8'), '{}\n');
    assert.equal(fs.existsSync(config + '.agenthaven-backup'), false);
    assert.equal(fs.existsSync(env.AGENTHAVEN_HOME), false);
  }

  assert.equal(run('claude-code').status, 0);
  assert.ok(JSON.parse(fs.readFileSync(config, 'utf8')).mcpServers.agenthaven);
  assert.equal(run('--off', 'claude-code').status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(config, 'utf8')).mcpServers, {});
});

test('CLI checks lists saved commands and only clears them explicitly', () => {
  const cli = path.join(__dirname, '..', 'bin', 'agenthaven.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-cli-checks-'));
  const env = { ...process.env, AGENTHAVEN_HOME: home, AGENTHAVEN_WORKSPACE: 'default' };
  const run = (...args) => spawnSync(process.execPath, [cli, 'checks', ...args], { cwd: home, encoding: 'utf8', env });
  const file = path.join(home, 'default.json');

  const empty = run();
  assert.equal(empty.status, 0);
  assert.equal(empty.stdout.trim(), 'No checks.');
  assert.equal(fs.existsSync(file), false);

  const configured = run('npm test', 'npm run lint');
  assert.equal(configured.status, 0);
  const before = fs.readFileSync(file);
  const listed = run();
  assert.equal(listed.status, 0);
  assert.deepEqual(listed.stdout.trim().split(/\r?\n/), ['- check 1: npm test', '- check 2: npm run lint']);
  assert.deepEqual(fs.readFileSync(file), before);

  for (const args of [['--clear', 'npm test'], ['npm test', '--clear'], ['--clear', '--workspace']]) {
    const mixed = run(...args);
    assert.equal(mixed.status, 1);
    assert.match(mixed.stderr, /usage: agenthaven checks --clear/);
    assert.deepEqual(fs.readFileSync(file), before);
  }

  const cleared = run('--clear');
  assert.equal(cleared.status, 0);
  assert.equal(cleared.stdout.trim(), 'No checks.');
  assert.deepEqual(new Store({ dataDir: home }).getSettings().checks, []);
});

test('tasks: create, claim, conflict-safe update, handoff, activity', () => {
  const s = tmpStore();
  const t = s.createTask({ title: 'Write docs', actor: 'claude' });
  assert.equal(t.status, 'todo');
  const claimed = s.claimTask(t.id, { actor: 'claude' });
  assert.equal(claimed.assignee, 'claude');
  assert.equal(claimed.status, 'doing');
  assert.throws(() => s.claimTask(t.id, { actor: 'cursor' }), { code: 'CONFLICT' });
  assert.throws(() => s.updateTask(t.id, { version: 1, status: 'review', actor: 'cursor' }), { code: 'CONFLICT' });
  assert.throws(() => s.updateTask(t.id, { status: 'review', actor: 'cursor' }), { code: 'INVALID' });
  const updated = s.updateTask(t.id, { version: claimed.version, status: 'review', actor: 'claude' });
  assert.equal(updated.version, claimed.version + 1);
  const handed = s.handoff(t.id, { actor: 'claude', to: 'cursor', summary: 'Draft done', nextSteps: 'Proofread' });
  assert.equal(handed.assignee, 'cursor');
  assert.equal(handed.handoffs[0].summary, 'Draft done');
  assert.deepEqual(s.activity().map((e) => e.action), ['task.handoff', 'task.updated', 'task.claimed', 'task.created']);
});

test('notes and validation', () => {
  const s = tmpStore();
  s.addNote({ title: 'Style', body: 'Use tabs', tags: ['conventions'], actor: 'codex' });
  assert.equal(s.listNotes({ query: 'TABS' }).length, 1);
  assert.equal(s.listNotes({ query: 'nope' }).length, 0);
  assert.throws(() => s.createTask({ title: '  ', actor: 'x' }), { code: 'INVALID' });
  assert.throws(() => new Store({ dataDir: os.tmpdir(), workspace: '../evil' }), { code: 'INVALID' });
});

test('two store instances share one workspace file', () => {
  const a = tmpStore();
  const b = new Store({ dataDir: a.dataDir });
  a.createTask({ title: 'From A', actor: 'a' });
  b.createTask({ title: 'From B', actor: 'b' });
  assert.deepEqual(a.listTasks().map((t) => t.title), ['From A', 'From B']);
});

test('MCP handler: initialize, list and call tools', () => {
  const h = createHandler({ store: tmpStore() });
  const init = h({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(h({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const names = h({ jsonrpc: '2.0', id: 2, method: 'tools/list' }).result.tools.map((t) => t.name);
  assert.ok(names.includes('claim_task') && names.includes('handoff_task'));
  const created = h({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_task', arguments: { title: 'Fix bug' } } });
  assert.equal(JSON.parse(created.result.content[0].text).createdBy, 'claude-code');
  const bad = h({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'claim_task', arguments: { id: 'task_missing' } } });
  assert.equal(bad.result.isError, true);
  assert.equal(h({ jsonrpc: '2.0', id: 5, method: 'nope' }).error.code, -32601);
});

test('MCP plugin works end-to-end over stdio', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'agenthaven.js'), 'mcp', '--agent', 'tester'], { env: { ...process.env, AGENTHAVEN_HOME: dir } });
  const lines = [];
  child.stdout.on('data', (d) => lines.push(...d.toString().trim().split('\n')));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_task', arguments: { title: 'stdio' } } })}\n`);
  child.stdin.end();
  await new Promise((r) => child.on('close', r));
  const [init, call] = lines.map((l) => JSON.parse(l));
  assert.equal(init.result.serverInfo.name, 'agenthaven');
  assert.equal(JSON.parse(call.result.content[0].text).createdBy, 'tester');
});

test('HTTP API: CRUD, conflict status, host/origin protection, UI', async () => {
  const { server, url } = await start({ store: tmpStore() });
  try {
    const json = { 'Content-Type': 'application/json' };
    const created = await (await fetch(`${url}api/tasks`, { method: 'POST', headers: json, body: JSON.stringify({ title: 'UI task' }) })).json();
    assert.equal(created.createdBy, 'you');
    const ok = await fetch(`${url}api/tasks/${created.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ version: 1, status: 'done' }) });
    assert.equal(ok.status, 200);
    const stale = await fetch(`${url}api/tasks/${created.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ version: 1, status: 'todo' }) });
    assert.equal(stale.status, 409);
    const evil = await fetch(`${url}api/tasks`, { method: 'POST', headers: { ...json, Origin: 'https://evil.example' }, body: '{"title":"x"}' });
    assert.equal(evil.status, 403);
    const page = await fetch(url);
    assert.match(await page.text(), /AgentHaven/);
    assert.equal((await fetch(`${url}..%2fpackage.json`)).status, 404);
  } finally {
    server.close();
  }
});

test('Node progress example claims a task, reports metrics and submits for review', async () => {
  const { dataDir } = tmpStore();
  const workspace = 'training';
  const store = new Store({ dataDir, workspace });
  const task = store.createTask({ title: 'Train the demo model', actor: 'you' });
  const { server, url } = await start({ dataDir });
  try {
    const example = path.join(__dirname, '..', 'examples', 'report_progress.mjs');
    const { stdout } = await promisify(execFile)(process.execPath, [example], {
      env: { ...process.env, AGENTHAVEN_URL: url, AGENTHAVEN_AGENT: 'demo-trainer', AGENTHAVEN_WORKSPACE: workspace },
      timeout: 20_000,
    });
    assert.match(stdout, /Sent to review/);
    const result = store.getTask(task.id);
    assert.equal(result.assignee, 'demo-trainer');
    assert.equal(result.status, 'review');
    assert.equal(result.progress, 100);
    assert.equal(result.metrics.loss.length, 10);
    assert.equal(result.metrics.accuracy.length, 10);
    assert.match(result.verification, /completed all 10 epochs/);
  } finally {
    server.close();
  }
});

test('file claims: overlapping files block other agents, not the owner', () => {
  const s = tmpStore();
  const a = s.createTask({ title: 'Refactor', files: ['./src/', 'README.md'], actor: 'claude' });
  assert.deepEqual(a.files, ['src', 'README.md']);
  s.claimTask(a.id, { actor: 'claude' });
  const b = s.createTask({ title: 'Fix', files: ['src\\store.js'], actor: 'cursor' });
  assert.equal(b.files[0], 'src/store.js');
  assert.throws(() => s.claimTask(b.id, { actor: 'cursor' }), (err) => err.code === 'CONFLICT' && /claude/.test(err.message));
  s.handoff(a.id, { actor: 'claude', to: 'codex', summary: 'x' });
  assert.throws(() => s.claimTask(b.id, { actor: 'cursor' }), /codex/);
  const c = s.createTask({ title: 'Docs', files: ['docs/index.html'], actor: 'cursor' });
  assert.equal(s.claimTask(c.id, { actor: 'cursor' }).assignee, 'cursor');
  const claims = s.fileClaims();
  assert.ok(claims.some((x) => x.file === 'docs/index.html' && x.agent === 'cursor'));
  const fresh = s.getTask(c.id);
  assert.throws(() => s.updateTask(c.id, { version: fresh.version, files: ['src/x.js'], actor: 'cursor' }), { code: 'CONFLICT' });
});

test('delete task needs the current version', () => {
  const s = tmpStore();
  const t = s.createTask({ title: 'Dup', actor: 'a' });
  assert.throws(() => s.deleteTask(t.id, { version: 99, actor: 'a' }), { code: 'CONFLICT' });
  assert.deepEqual(s.deleteTask(t.id, { version: 1, actor: 'a' }), { deleted: t.id });
  assert.equal(s.listTasks().length, 0);
});

test('workspaces are isolated and listed', async () => {
  const s = tmpStore();
  const { server, url } = await start({ dataDir: s.dataDir });
  try {
    const json = { 'Content-Type': 'application/json' };
    await fetch(`${url}api/tasks?workspace=alpha`, { method: 'POST', headers: json, body: '{"title":"A"}' });
    assert.equal((await (await fetch(`${url}api/tasks?workspace=alpha`)).json()).length, 1);
    assert.equal((await (await fetch(`${url}api/tasks`)).json()).length, 0);
    assert.deepEqual(await (await fetch(`${url}api/workspaces`)).json(), ['alpha', 'default']);
    assert.equal((await fetch(`${url}api/tasks?workspace=..%2Fx`)).status, 400);
    const [task] = await (await fetch(`${url}api/tasks?workspace=alpha`)).json();
    assert.equal((await fetch(`${url}api/tasks/${task.id}?workspace=alpha&version=1`, { method: 'DELETE' })).status, 200);
  } finally {
    server.close();
  }
});

test('connect: merges into client config without losing settings, refuses broken JSON', () => {
  const connect = require('../src/connect');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-home-'));
  const opts = { home, platform: 'darwin', env: {} };
  const file = connect.clients(opts).claude.file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } }));
  const entry = connect.serverEntry({ command: '/app', script: '/app/bin/agenthaven.js', agent: 'claude', extraEnv: { ELECTRON_RUN_AS_NODE: '1' } });
  connect.install('claude', entry, opts);
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(cfg.theme, 'dark');
  assert.ok(cfg.mcpServers.other);
  assert.deepEqual(cfg.mcpServers.agenthaven.args, ['/app/bin/agenthaven.js', 'mcp', '--agent', 'claude', '--workspace', 'default']);
  assert.ok(fs.existsSync(`${file}.agenthaven-backup`));
  const cursor = connect.clients(opts).cursor.file;
  fs.mkdirSync(path.dirname(cursor), { recursive: true });
  fs.writeFileSync(cursor, '{ broken');
  assert.throws(() => connect.install('cursor', entry, opts), /not valid JSON/);
  assert.equal(fs.readFileSync(cursor, 'utf8'), '{ broken');
  assert.match(connect.clients({ home, platform: 'win32', env: { APPDATA: 'C:\\U\\AppData' } }).claude.file, /Claude/);
});
