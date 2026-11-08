'use strict';

// Which board events need a person, and what the desktop notification says.
// Pure functions with no Electron, so the choice is easy to test; desktop/main.js
// only shows what this returns.

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

module.exports = { pick, forStore };
