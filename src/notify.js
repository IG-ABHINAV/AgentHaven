'use strict';

// Which board events need a person, and what the desktop notification says.
// Pure functions with no Electron, so the choice is easy to test; desktop/main.js
// only shows what this returns.

const fs = require('node:fs');
const path = require('node:path');

const clip = (s, n = 160) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// `isHuman(name)` says whether a board name is a person ('you', 'humans' or an
// agent of kind human). `taskOf(id)` returns the task, or null, so a review
// can be checked for a human reviewer and every notification can name its task.
function pick(events, { isHuman = (n) => n === 'you' || n === 'humans', taskOf = () => null } = {}) {
  const out = [];
  for (const e of events || []) {
    if (!e || isHuman(e.actor)) continue; // a person does not need to hear about their own steps
    const task = e.ref ? taskOf(e.ref) : null;
    const name = task?.title ? `"${clip(task.title, 80)}"` : 'a task';
    const d = e.detail;
    let note = null;
    switch (e.action) {
      case 'task.question':
        if (isHuman(d?.to)) note = { title: `${e.actor} has a question`, body: `On ${name}: ${clip(d.question)}` };
        break;
      case 'message.sent':
        if (isHuman(d?.to)) note = { title: `Message from ${e.actor}`, body: clip(d.body) };
        break;
      case 'task.review_requested':
        if (task?.reviewer && isHuman(task.reviewer)) note = { title: 'Review ready', body: `${e.actor} asks you to review ${name}: ${clip(d)}` };
        break;
      case 'task.escalated':
        note = { title: 'A task needs a decision', body: `${name}: ${clip(d)}` };
        break;
      case 'task.budget_exceeded':
        note = { title: 'Budget reached', body: `${name} stopped: ${clip(d)}. Raise the budget or stop the task.` };
        break;
      default:
    }
    if (note) out.push({ ...note, seq: e.seq, taskId: task?.id || (e.action.startsWith('task.') ? e.ref : null) || null });
  }
  return out;
}

// Board-aware wrapper: reads tasks and agents once from a Store snapshot.
function forStore(data) {
  const tasks = new Map((data?.tasks || []).map((t) => [t.id, t]));
  const agents = data?.agents || {};
  return {
    isHuman: (n) => n === 'you' || n === 'humans' || agents[n]?.kind === 'human',
    taskOf: (id) => tasks.get(id) || null,
  };
}

// How many things wait for a person right now: the number on the dock or taskbar badge.
function pending(data) {
  const { isHuman } = forStore(data);
  let n = 0;
  for (const t of data?.tasks || []) {
    if (t.status === 'done') continue;
    n += (t.questions || []).filter((q) => q.answer == null && isHuman(q.to)).length;
    if (t.escalated) n += 1;
    if (t.status === 'review' && t.reviewer && isHuman(t.reviewer)) n += 1;
    if (t.status === 'blocked' && /^Budget exceeded/.test(t.blockedReason || '')) n += 1;
  }
  return n;
}

// Follows every workspace in `dataDir` and calls `show` once per new event that needs a person.
// The cursor per workspace lives in `stateFile`, so a restart neither repeats nor floods:
// a workspace seen for the first time starts at its latest event.
// `show({ title, body, workspace, taskId })`, `setBadge(count)`; both may be omitted.
const MAX_PER_TICK = 3;

function createWatcher({ dataDir, stateFile, show = () => {}, setBadge = () => {}, intervalMs = 5000, Store = require('./store').Store } = {}) {
  let state = { enabled: true, cursors: {} };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; } catch { /* first start */ }
  const stores = new Map();
  let timer = null;

  const save = () => {
    if (!stateFile) return;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const tmp = `${stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, stateFile);
    } catch { /* not fatal: at worst a notification repeats after a restart */ }
  };

  function tick() {
    let badge = 0;
    let changed = false;
    for (const ws of Store.listWorkspaces(dataDir)) {
      if (!stores.has(ws)) stores.set(ws, new Store({ dataDir, workspace: ws }));
      const store = stores.get(ws);
      let data;
      try { data = store.read(); } catch { continue; } // a half-written or broken file: try again next time
      badge += pending(data);
      const since = state.cursors[ws];
      if (since === undefined || since > data.seq) { // new workspace, or the file was replaced
        state.cursors[ws] = data.seq || 0;
        changed = true;
        continue;
      }
      if (since === data.seq) continue;
      const helpers = forStore(data);
      const notes = [];
      let cursor = since;
      for (;;) {
        const page = store.events({ since: cursor, limit: 500 });
        notes.push(...pick(page.events, helpers));
        if (page.cursor === cursor || page.cursor >= page.latest) { cursor = Math.max(page.cursor, cursor); break; }
        cursor = page.cursor;
      }
      state.cursors[ws] = cursor;
      changed = true;
      if (!state.enabled) continue;
      for (const n of notes.slice(0, MAX_PER_TICK)) show({ ...n, workspace: ws });
      if (notes.length > MAX_PER_TICK) {
        show({ title: `${notes.length - MAX_PER_TICK} more things need you`, body: `In workspace ${ws}. Open AgentHaven to see them.`, workspace: ws, taskId: null });
      }
    }
    if (changed) save();
    setBadge(state.enabled ? badge : 0);
    return badge;
  }

  const safeTick = () => { try { tick(); } catch { /* keep watching */ } };
  return {
    tick,
    start() { if (!timer) { safeTick(); timer = setInterval(safeTick, intervalMs); timer.unref?.(); } return this; },
    stop() { if (timer) clearInterval(timer); timer = null; },
    get enabled() { return state.enabled; },
    setEnabled(on) { state.enabled = Boolean(on); save(); safeTick(); },
  };
}

module.exports = { pick, forStore, pending, createWatcher };
