'use strict';
// Agent connection: finds the MCP clients installed on this computer and adds the
// AgentHaven MCP server to their config, keeping every other setting intact.
//
// - detect():      which clients are installed, and whether AgentHaven is connected,
//                  outdated (points at an old or moved app) or missing.
// - autoConnect(): connect every installed client that is not connected yet and repair
//                  outdated entries. Clients the user disconnected stay disconnected.
// - install() / uninstall(): one client. A backup of the old file is kept next to it
//                  (*.agenthaven-backup) and files are replaced atomically.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NAME = 'agenthaven';

function clients({ home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const appSupport = platform === 'win32' ? appData
    : platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
      : (env.XDG_CONFIG_HOME || path.join(home, '.config'));
  const claudeDir = path.join(appSupport, 'Claude');
  const codeUser = path.join(appSupport, 'Code', 'User');
  const codexHome = env.CODEX_HOME || path.join(home, '.codex');
  return {
    claude: { label: 'Claude Desktop', agent: 'claude', file: path.join(claudeDir, 'claude_desktop_config.json'), detect: [claudeDir] },
    'claude-code': { label: 'Claude Code', agent: 'claude-code', file: path.join(home, '.claude.json'), detect: [path.join(home, '.claude.json'), path.join(home, '.claude')], plugins: path.join(home, '.claude', 'plugins', 'installed_plugins.json') },
    cursor: { label: 'Cursor', agent: 'cursor', file: path.join(home, '.cursor', 'mcp.json'), detect: [path.join(home, '.cursor')] },
    vscode: { label: 'VS Code (Copilot)', agent: 'copilot', file: path.join(codeUser, 'mcp.json'), detect: [codeUser], key: 'servers', stdioType: true },
    windsurf: { label: 'Windsurf', agent: 'windsurf', file: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), detect: [path.join(home, '.codeium', 'windsurf')] },
    gemini: { label: 'Gemini CLI', agent: 'gemini', file: path.join(home, '.gemini', 'settings.json'), detect: [path.join(home, '.gemini')] },
    codex: { label: 'Codex', agent: 'codex', file: path.join(codexHome, 'config.toml'), detect: [codexHome], format: 'toml' },
    lmstudio: { label: 'LM Studio', agent: 'lmstudio', file: path.join(home, '.lmstudio', 'mcp.json'), detect: [path.join(home, '.lmstudio')] },
  };
}

function serverEntry({ command, script, agent, workspace = 'default', extraEnv = {} }) {
  return { command, args: [script, 'mcp', '--agent', agent, '--workspace', workspace], ...(Object.keys(extraEnv).length ? { env: extraEnv } : {}) };
}

function readIfExists(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

// Write next to the target and rename over it, so a crash never leaves half a config.
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.agenthaven-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  try { fs.renameSync(tmp, file); } catch (err) { fs.rmSync(tmp, { force: true }); throw err; }
}

function backup(client, raw) {
  if (raw) fs.writeFileSync(`${client.file}.agenthaven-backup`, raw);
}

// ---- TOML (Codex) -------------------------------------------------------------------

const TOML_RE = /^\[mcp_servers\.agenthaven\][^\n]*\n(?:(?!\[)[^\n]*\n?)*/m;

function tomlBlock(entry) {
  const q = (v) => JSON.stringify(String(v));
  const lines = ['[mcp_servers.agenthaven]', `command = ${q(entry.command)}`, `args = [${entry.args.map(q).join(', ')}]`];
  if (entry.env) lines.push(`env = { ${Object.entries(entry.env).map(([k, v]) => `${k} = ${q(v)}`).join(', ')} }`);
  return `${lines.join('\n')}\n`;
}

function tomlEntry(text) {
  const m = text && text.match(TOML_RE);
  if (!m) return null;
  const str = (re) => { const x = m[0].match(re); try { return x ? JSON.parse(x[1]) : undefined; } catch { return undefined; } };
  return { command: str(/^command\s*=\s*("(?:[^"\\]|\\.)*")/m), args: str(/^args\s*=\s*(\[.*\])\s*$/m) || [] };
}

// ---- JSON clients -------------------------------------------------------------------

// VS Code, Cursor and Zed allow comments and trailing commas in their JSON settings.
// Remove them outside strings so such files can still be read.
function stripJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1); i = j;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function readJson(client) {
  const raw = readIfExists(client.file);
  if (raw === null || !raw.trim()) return { raw, config: {} };
  try { return { raw, config: JSON.parse(raw) }; } catch { /* try JSON with comments */ }
  try { return { raw, config: JSON.parse(stripJsonc(raw)) }; } catch {
    const err = new Error(`${client.file} is not valid JSON; fix it first, AgentHaven will not overwrite it`);
    err.code = 'BROKEN_CONFIG';
    throw err;
  }
}

function currentEntry(client) {
  if (client.format === 'toml') return tomlEntry(readIfExists(client.file));
  const { config } = readJson(client);
  return (config[client.key || 'mcpServers'] || {})[NAME] || null;
}

function install(clientId, entry, opts = {}) {
  const client = clients(opts)[clientId];
  if (!client) throw Object.assign(new Error(`unknown client ${clientId}`), { code: 'INVALID' });
  if (client.format === 'toml') {
    let text = readIfExists(client.file) || '';
    backup(client, text);
    const block = tomlBlock(entry);
    text = TOML_RE.test(text) ? text.replace(TOML_RE, `${block}\n`) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}${block}`;
    writeAtomic(client.file, text);
    return client;
  }
  const { raw, config } = readJson(client);
  backup(client, raw);
  const key = client.key || 'mcpServers';
  config[key] = { ...(config[key] || {}), [NAME]: client.stdioType ? { type: 'stdio', ...entry } : entry };
  writeAtomic(client.file, `${JSON.stringify(config, null, 2)}\n`);
  return client;
}

function uninstall(clientId, opts = {}) {
  const client = clients(opts)[clientId];
  if (!client) throw Object.assign(new Error(`unknown client ${clientId}`), { code: 'INVALID' });
  if (client.format === 'toml') {
    const text = readIfExists(client.file);
    if (!text || !TOML_RE.test(text)) return client;
    backup(client, text);
    writeAtomic(client.file, text.replace(TOML_RE, '').replace(/\n{3,}/g, '\n\n'));
    return client;
  }
  const { raw, config } = readJson(client);
  const key = client.key || 'mcpServers';
  if (!config[key] || !config[key][NAME]) return client;
  backup(client, raw);
  delete config[key][NAME];
  writeAtomic(client.file, `${JSON.stringify(config, null, 2)}\n`);
  return client;
}

// Claude Code with the AgentHaven plugin already has the tools; adding them again
// would show every tool twice.
function hasClaudePlugin(client) {
  if (!client.plugins) return false;
  try { return /"agenthaven@/.test(fs.readFileSync(client.plugins, 'utf8')); } catch { return false; }
}

// Is Node.js installed for the user? A desktop app often starts with a short PATH (macOS
// apps do not read the shell profile), so look in the usual places and ask the login shell.
let nodeCache;
function hasNode({ platform = process.platform, env = process.env, home = os.homedir(), shell = true } = {}) {
  if (nodeCache !== undefined && shell) return nodeCache;
  const names = platform === 'win32' ? ['node.exe'] : ['node'];
  const dirs = (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  if (platform === 'win32') dirs.push(path.join(env.ProgramFiles || 'C:\\Program Files', 'nodejs'), path.join(env.APPDATA || '', 'nvm'), path.join(env.LOCALAPPDATA || '', 'Volta', 'bin'));
  else dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', path.join(home, '.volta', 'bin'), path.join(home, '.local', 'bin'), path.join(home, '.asdf', 'shims'));
  let found = dirs.some((d) => names.some((n) => exists(path.join(d, n))));
  if (!found) {
    for (const root of [path.join(home, '.nvm', 'versions', 'node'), path.join(home, '.local', 'share', 'fnm', 'node-versions')]) {
      try { if (fs.readdirSync(root).length) found = true; } catch { /* not there */ }
    }
  }
  if (!found && shell && platform !== 'win32') {
    const r = require('node:child_process').spawnSync(env.SHELL || '/bin/sh', ['-ilc', 'command -v node'], { encoding: 'utf8', timeout: 4000 });
    found = r.status === 0 && /node/.test(r.stdout || '');
  }
  if (shell) nodeCache = found;
  return found;
}

const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

function sameEntry(a, b) {
  return Boolean(a && b) && a.command === b.command && JSON.stringify(a.args || []) === JSON.stringify(b.args || []);
}

/**
 * State of every known client. `entryFor(agent)` gives the entry this app would write.
 * state: connected | outdated | not-connected | plugin | broken-config | not-installed
 */
function detect({ entryFor, ...opts } = {}) {
  return Object.entries(clients(opts)).map(([id, c]) => {
    const installed = c.detect.some(exists);
    const base = { id, label: c.label, agent: c.agent, file: c.file, installed };
    let entry;
    try { entry = currentEntry(c); } catch (err) { return { ...base, state: 'broken-config', error: err.message }; }
    if (hasClaudePlugin(c)) {
      // The plugin starts its MCP server with `node`. Without Node.js the app connects Claude
      // Code itself; once Node.js is there, that second entry is a duplicate.
      const node = opts.hasNode !== undefined ? opts.hasNode : hasNode(opts);
      if (node) return { ...base, installed: true, state: 'plugin', duplicate: Boolean(entry) };
      if (!entry) return { ...base, installed: true, state: 'not-connected', reason: 'The plugin needs Node.js, which is not installed: AgentHaven connects Claude Code through the app.' };
    }
    if (!entry) return { ...base, state: installed ? 'not-connected' : 'not-installed' };
    const want = entryFor && entryFor(c.agent);
    // Outdated: the command no longer exists (app moved or removed), or it is not the
    // runtime this app would use (for example an old install path).
    const missing = entry.command && path.isAbsolute(entry.command) && !exists(entry.command);
    const script = (entry.args || []).find((a) => /agenthaven\.js$/.test(a));
    const scriptMissing = script && path.isAbsolute(script) && !exists(script);
    if (missing || scriptMissing || (want && !sameEntry(entry, want))) return { ...base, installed: true, state: 'outdated', command: entry.command };
    return { ...base, installed: true, state: 'connected', command: entry.command };
  });
}

/**
 * Connect every installed client that is not connected, and repair outdated ones.
 * @param {{entryFor:(agent:string)=>object, off?:string[], repairOnly?:boolean}} o
 */
function autoConnect({ entryFor, off = [], repairOnly = false, ...opts }) {
  const results = [];
  for (const c of detect({ entryFor, ...opts })) {
    if (c.duplicate) {
      try { uninstall(c.id, opts); results.push({ id: c.id, label: c.label, action: 'deduplicated' }); } catch { /* leave it */ }
      continue;
    }
    if (off.includes(c.id) || !['not-connected', 'outdated'].includes(c.state)) continue;
    if (repairOnly && c.state !== 'outdated') continue;
    try {
      install(c.id, entryFor(c.agent), opts);
      results.push({ id: c.id, label: c.label, action: c.state === 'outdated' ? 'repaired' : 'connected' });
    } catch (err) {
      results.push({ id: c.id, label: c.label, action: 'error', error: err.message });
    }
  }
  return results;
}

// ---- preferences: { auto: true, off: [client ids the user disconnected] } -------------

function prefsFile(dataDir) { return path.join(dataDir, 'connections.json'); }
function loadPrefs(dataDir) {
  try { const p = JSON.parse(fs.readFileSync(prefsFile(dataDir), 'utf8')); return { auto: p.auto !== false, off: Array.isArray(p.off) ? p.off : [] }; } catch { return { auto: true, off: [] }; }
}
function savePrefs(dataDir, prefs) {
  writeAtomic(prefsFile(dataDir), `${JSON.stringify({ auto: prefs.auto !== false, off: [...new Set(prefs.off || [])] }, null, 2)}\n`);
  return loadPrefs(dataDir);
}

// The entry for a plain Node install (agenthaven serve / CLI). Run through npx, the code
// lives in npx's cache, which can be cleared: then the entry starts it through npx again.
function nodeEntryFor(agent, workspace = 'default', { dir = __dirname, platform = process.platform } = {}) {
  if (/[\\/]_npx[\\/]/.test(dir)) {
    const args = ['-y', 'github:laaielichter/AgentHaven', 'mcp', '--agent', agent, '--workspace', workspace];
    return platform === 'win32' ? { command: 'cmd', args: ['/c', 'npx', ...args] } : { command: 'npx', args };
  }
  return serverEntry({ command: process.execPath, script: path.join(dir, '..', 'bin', 'agenthaven.js'), agent, workspace });
}

module.exports = { hasNode, stripJsonc, clients, serverEntry, install, uninstall, detect, autoConnect, loadPrefs, savePrefs, nodeEntryFor, NAME };
