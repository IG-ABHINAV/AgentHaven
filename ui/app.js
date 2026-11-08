'use strict';
const STATUSES = ['todo', 'doing', 'blocked', 'review', 'done'];
const LABELS = { todo: 'To do', doing: 'Doing', blocked: 'Blocked', review: 'Review', done: 'Done' };
const KIND_ICON = { llm: '🤖', human: '🧑', 'neural-network': '🧠', script: '⚙️', other: '◆' };
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const statusEl = $('#status');
const SVG = 'http://www.w3.org/2000/svg';

let workspace = 'default';
try { workspace = localStorage.getItem('workspace') || 'default'; } catch { /* storage blocked */ }
let tasks = [];
let agents = [];
let editing = null; // full task being edited
let draftCriteria = [];
let dragging = null;

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

async function api(path, opts = {}) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${path}${sep}workspace=${encodeURIComponent(workspace)}`, { ...opts, headers: { 'Content-Type': 'application/json' }, body: opts.body && JSON.stringify(opts.body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const ago = (iso) => {
  if (!iso) return '';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  return s < 45 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : new Date(iso).toLocaleDateString();
};
const until = (iso) => {
  const m = Math.round((new Date(iso) - Date.now()) / 60000);
  return m <= 0 ? 'expiring' : m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
};
const money = (n) => `$${(n || 0).toFixed(2)}`;
const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n || 0));
const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(4));
const presenceOf = (name) => agents.find((a) => a.name === name)?.presence || 'offline';

function showError(err) { statusEl.textContent = err.message; statusEl.classList.add('err'); }
async function act(fn) {
  try { await fn(); } catch (err) { showError(err); return false; }
  await refresh(true);
  return true;
}

// ---- board -------------------------------------------------------------------

function visible(task) {
  const q = $('#filter').value.trim().toLowerCase();
  const who = $('#filter-agent').value;
  if (who && task.assignee !== who) return false;
  if (!q) return true;
  return `${task.title} ${task.id} ${task.assignee || ''} ${task.files.join(' ')} ${task.skills.join(' ')}`.toLowerCase().includes(q);
}

function card(task) {
  const open = task.criteria.filter((c) => !c.done).length;
  const waiting = task.waitingOn?.length && task.status === 'todo';
  const meta = [
    el('span', { className: `tag p${task.priority}`, textContent: `P${task.priority}` }),
    task.assignee ? el('span', { className: 'who' }, el('span', { className: `dot ${presenceOf(task.assignee)}` }), task.assignee) : null,
    waiting ? el('span', { className: 'tag warn', title: `Starts after ${task.waitingOn.join(', ')}`, textContent: `🔒 ${task.waitingOn.length}` }) : null,
    task.criteria.length ? el('span', { className: `tag ${open ? '' : 'ok'}`, title: 'Acceptance criteria', textContent: `✓ ${task.criteria.length - open}/${task.criteria.length}` }) : null,
    task.review ? el('span', { className: 'tag info', title: 'Needs review by someone else', textContent: 'review' }) : null,
    task.comments ? el('span', { className: 'tag', title: 'Comments', textContent: `💬 ${task.comments}` }) : null,
    task.openQuestions ? el('span', { className: 'tag warn', title: 'Open questions', textContent: `❓ ${task.openQuestions}` }) : null,
    task.escalated ? el('span', { className: 'tag bad', title: task.escalated.reason, textContent: '⚠ escalated' }) : null,
    task.children ? el('span', { className: `tag ${task.children.done === task.children.total ? 'ok' : ''}`, title: 'Subtasks done', textContent: `⑂ ${task.children.done}/${task.children.total}` }) : null,
    task.status === 'review' && task.reviewer ? el('span', { className: 'tag info', title: 'Reviewer', textContent: `👀 ${task.reviewer}` }) : null,
    task.lastReceipt ? el('span', { className: `tag ${task.lastReceipt.status === 'passed' ? 'ok' : task.lastReceipt.status === 'failed' ? 'bad' : 'info'}`, title: `AgentHaven checks on ${task.lastReceipt.sha.slice(0, 10)}`, textContent: task.lastReceipt.status === 'passed' ? '✔ checks' : task.lastReceipt.status === 'failed' ? '✗ checks' : '⏳ checks' }) : null,
    task.scope && !task.scope.ok ? el('span', { className: 'tag warn', title: [...task.scope.outOfScope, ...task.scope.foreign.flatMap((f) => f.files)].join(', '), textContent: '⚠ scope' }) : null,
    task.protectedTouched?.length ? el('span', { className: 'tag bad', title: `Protected paths changed: ${task.protectedTouched.join(', ')}`, textContent: '🛡 tests changed' }) : null,
    task.worktree ? el('span', { className: 'tag', title: `${task.worktree.branch}\n${task.worktree.path}`, textContent: '⎇ branch' }) : null,
    task.parent ? el('span', { className: 'tag', title: `Subtask of ${tasks.find((x) => x.id === task.parent)?.title || task.parent}`, textContent: '↳ sub' }) : null,
    task.usage.costUsd || task.usage.tokens ? el('span', { className: `tag ${task.budget ? 'warn' : ''}`, title: 'Spent', textContent: task.usage.costUsd ? money(task.usage.costUsd) + (task.budget?.costUsd !== undefined ? `/${money(task.budget.costUsd)}` : '') : `${tokens(task.usage.tokens)} tok` }) : null,
    task.leaseUntil ? el('span', { className: 'tag', title: `Claim expires ${new Date(task.leaseUntil).toLocaleTimeString()} without activity`, textContent: `⏱ ${until(task.leaseUntil)}` }) : null,
    ...task.skills.map((s) => el('span', { className: 'tag', textContent: s })),
  ];
  const metricBits = Object.entries(task.metrics || {}).slice(0, 3).map(([k, v]) => `${k} ${fmt(v)}`).join(' · ');
  const node = el('button', { className: `card p${task.priority}${waiting ? ' waiting' : ''}${task.escalated ? ' escalated' : ''}`, type: 'button', draggable: true, title: 'Open (drag to move)', onclick: () => openTask(task.id) },
    el('span', { className: 't', textContent: task.title }),
    el('span', { className: 'meta' }, meta),
    task.progress != null && task.status !== 'done' ? el('span', { className: 'bar', title: `${task.progress}%` }, el('span')) : null,
    task.progressNote || metricBits ? el('span', { className: 'note', textContent: [task.progressNote, metricBits].filter(Boolean).join(' — ') }) : null,
    task.blockedReason ? el('span', { className: 'reason', textContent: task.blockedReason }) : null,
    task.files.length ? el('span', { className: 'files', title: task.files.join('\n'), textContent: task.files.join(', ') }) : null,
    task.lastHandoff && task.status === 'todo' ? el('span', { className: 'note', textContent: `↪ ${task.lastHandoff.from}: ${task.lastHandoff.summary}` }) : null);
  const bar = node.querySelector('.bar > span');
  if (bar) bar.style.width = `${task.progress}%`;
  node.addEventListener('dragstart', () => { dragging = task; });
  return node;
}

function column(status) {
  const list = tasks.filter((t) => t.status === status && visible(t))
    .sort((a, b) => (status === 'done' ? b.updatedAt.localeCompare(a.updatedAt) : a.priority - b.priority || a.createdAt.localeCompare(b.createdAt)));
  const col = el('div', { className: 'col', role: 'list', ariaLabel: LABELS[status] },
    el('h3', {}, LABELS[status], el('span', { textContent: list.length })),
    list.length ? list.slice(0, status === 'done' ? 30 : 200).map(card) : el('p', { className: 'empty', textContent: status === 'todo' ? 'Nothing waiting.' : '—' }));
  col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('over'); });
  col.addEventListener('dragleave', () => col.classList.remove('over'));
  col.addEventListener('drop', (e) => {
    e.preventDefault(); col.classList.remove('over');
    if (dragging && dragging.status !== status) {
      const t = dragging;
      act(() => api(`/api/tasks/${t.id}`, { method: 'PATCH', body: { version: t.version, status } }));
    }
    dragging = null;
  });
  return col;
}

function renderStats(s) {
  const chip = (label, value, title) => el('span', { className: 'chip', title: title || label }, el('b', { textContent: value }), label);
  $('#stats').replaceChildren(...[
    chip('doing', s.counts.doing), chip('to do', s.counts.todo), chip('review', s.counts.review),
    s.counts.blocked ? chip('blocked', s.counts.blocked) : null, chip('done', s.counts.done),
    s.escalated ? chip('escalated', `⚠ ${s.escalated}`) : null, s.openQuestions ? chip('open questions', `❓ ${s.openQuestions}`) : null,
    chip('agents online', `${s.online}/${s.agents}`), chip('spent', money(s.usage.costUsd), `${tokens(s.usage.tokens)} tokens`)].filter(Boolean));
}

function renderAgents() {
  $('#agents').replaceChildren(...(agents.length ? agents.map((a) => el('li', {},
    el('span', { title: a.presence }, el('span', { className: `dot ${a.presence}` })),
    el('span', { className: 'name' }, `${KIND_ICON[a.kind] || '◆'} ${a.name}`, a.role === 'lead' ? el('span', { className: 'lead-badge', textContent: '★ lead' }) : null),
    el('span', { className: 'sub', textContent: [[a.vendor, a.model].filter(Boolean).join(' · '), a.tasks.length ? `on ${a.tasks.map((t) => t.title).join(', ')}` : a.presence === 'online' ? 'free' : `seen ${ago(a.lastSeen)}`, a.status].filter(Boolean).join(' — ') }),
    a.skills.length ? el('span', { className: 'sub', textContent: a.skills.join(', ') }) : null))
    : [el('li', { className: 'empty', textContent: 'No agents yet.' })]));
  $('#agent-names').replaceChildren(...agents.map((a) => el('option', { value: a.name })));
  const sel = $('#filter-agent');
  const cur = sel.value;
  sel.replaceChildren(el('option', { value: '', textContent: 'All agents' }), ...agents.map((a) => el('option', { value: a.name, textContent: a.name, selected: a.name === cur })));
}

async function render() {
  const q = $('#note-search').value.trim();
  const [t, notes, activity, claims, ag, stats] = await Promise.all([
    api('/api/tasks'), api(`/api/notes${q ? `?q=${encodeURIComponent(q)}` : ''}`), api('/api/activity?limit=40'), api('/api/claims'), api('/api/agents'), api('/api/stats'),
  ]);
  tasks = t; agents = ag;
  renderStats(stats);
  renderTeam(stats);
  await renderInbox();
  renderAgents();
  $('#board').replaceChildren(...STATUSES.map(column));
  $('#onboarding').hidden = tasks.length > 0 || activity.length > 0;
  $('#claims').replaceChildren(...(claims.length ? claims.map((c) => el('li', {}, el('code', { textContent: c.file }), ' ', el('span', { className: 'who' }, el('span', { className: `dot ${presenceOf(c.agent)}` }), c.agent)))
    : [el('li', { className: 'empty', textContent: 'No files claimed.' })]));
  $('#notes').replaceChildren(...(notes.length ? notes.slice().reverse().map((n) => el('li', {}, el('strong', { textContent: n.title }), el('div', { className: 'body', textContent: n.body }), el('div', { className: 'm', textContent: `${n.author} · ${ago(n.createdAt)}${n.tags.length ? ` · #${n.tags.join(' #')}` : ''}` })))
    : [el('li', { className: 'empty', textContent: q ? 'No matching notes.' : 'No notes yet.' })]));
  $('#activity').replaceChildren(...(activity.length ? activity.map((e) => el('li', {}, el('strong', { textContent: e.actor }), ` ${e.action.replace(/^task\./, '').replace(/[._]/g, ' ')} `, e.ref?.startsWith('task_') ? el('code', { textContent: tasks.find((x) => x.id === e.ref)?.title || e.ref }) : null, ' ', el('span', { className: 'm', textContent: ago(e.at) })))
    : [el('li', { className: 'empty', textContent: 'Nothing yet.' })]));
  await renderDreams();
  await renderGuard();
  await renderCode();
  statusEl.textContent = live ? 'Live' : 'Polling';
  statusEl.classList.remove('err');
}

let pending = false;
async function refresh(force) {
  if (!force && document.querySelector('dialog[open]')) { pending = true; return; } // don't redraw under an open dialog
  pending = false;
  try { await render(); } catch (err) { statusEl.textContent = `Offline: ${err.message}`; statusEl.classList.add('err'); }
}

// ---- live updates ------------------------------------------------------------

let live = false;
let source = null;
let timer = null;
function connect() {
  source?.close();
  clearTimeout(timer);
  if (!window.EventSource) return poll();
  source = new EventSource(`/api/stream?workspace=${encodeURIComponent(workspace)}`);
  let debounce;
  source.addEventListener('change', () => { live = true; clearTimeout(debounce); debounce = setTimeout(() => refresh(), 120); });
  source.onerror = () => { live = false; source.close(); timer = setTimeout(connect, 3000); };
}
function poll() { refresh(); timer = setTimeout(poll, 4000); }
setInterval(() => { if (!document.querySelector('dialog[open]')) refresh(); }, 30000); // lease timers and presence

// ---- task dialog ---------------------------------------------------------------

function selectTab(name) {
  $$('.tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('.tab').forEach((p) => { p.hidden = p.dataset.panel !== name; });
}
$$('.tabs [role=tab]').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));

function sparkline(points) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 200 46');
  svg.setAttribute('preserveAspectRatio', 'none');
  if (points.length < 2) return svg;
  const vs = points.map((p) => p.v);
  const lo = Math.min(...vs); const hi = Math.max(...vs); const span = hi - lo || 1;
  const d = vs.map((v, i) => `${i ? 'L' : 'M'}${(i / (vs.length - 1)) * 200},${42 - ((v - lo) / span) * 38}`).join(' ');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

function fillDialog(task) {
  const f = $('#task-form');
  const isNew = !task.id;
  $('#dlg-h').textContent = isNew ? 'New task' : 'Task';
  $('#dlg-id').textContent = task.id || '';
  f.title.value = task.title || '';
  f.description.value = task.description || '';
  f.status.replaceChildren(...STATUSES.map((s) => el('option', { value: s, textContent: LABELS[s], selected: s === (task.status || 'todo') })));
  f.status.disabled = isNew;
  f.priority.value = String(task.priority ?? 2);
  f.assignee.value = task.assignee || '';
  f.assignee.disabled = isNew;
  f.skills.value = (task.skills || []).join(', ');
  f.files.value = (task.files || []).join('\n');
  f.review.checked = Boolean(task.review);
  f.budgetCost.value = task.budget?.costUsd ?? '';
  f.budgetTokens.value = task.budget?.tokens ?? '';
  const deps = new Set(task.dependsOn || []);
  const others = tasks.filter((t) => t.id !== task.id && t.status !== 'done' || deps.has(t.id));
  $('#dlg-deps').replaceChildren(...(others.length ? others.map((t) => el('label', {}, el('input', { type: 'checkbox', value: t.id, checked: deps.has(t.id) }), `${t.title} `, el('span', { className: 'm', textContent: LABELS[t.status] })))
    : [el('span', { className: 'm', textContent: 'No other open tasks.' })]));

  $('#dlg-escalated').hidden = !task.escalated;
  $('#dlg-escalated-text').textContent = task.escalated ? `Escalated: ${task.escalated.reason}` : '';
  const subs = task.subtasks || [];
  $('#dlg-sub-wrap').hidden = isNew;
  $('#dlg-subtasks').replaceChildren(...(subs.length ? subs.map((c) => el('li', {}, `${c.status === 'done' ? '✓' : '○'} ${c.title} `, el('span', { className: 'm', textContent: `${LABELS[c.status]}${c.assignee ? ` · ${c.assignee}` : ''}` })))
    : [el('li', { className: 'm', textContent: 'No subtasks. Split a task that is too big for one session.' })]));
  const qs = task.questions || [];
  $('#dlg-questions').replaceChildren(...qs.map((q) => el('li', { className: 'k-question' },
    el('span', { className: 'm', textContent: `${q.from} asks ${q.to} · ${ago(q.at)}` }), el('div', { className: 'body', textContent: q.text }),
    q.answer ? el('div', { className: 'body', textContent: `↳ ${q.answeredBy}: ${q.answer}` })
      : el('div', { className: 'row' }, el('input', { className: 'grow', placeholder: 'Your answer', id: `ans-${q.id}` }), el('button', { type: 'button', textContent: 'Answer', onclick: () => answer(task.id, q.id, $(`#ans-${q.id}`).value) })))));
  const banner = $('#dlg-banner');
  const waiting = task.waitingOn || [];
  banner.hidden = !(task.blockedReason || waiting.length || task.status === 'review');
  banner.className = `banner${task.blockedReason ? ' bad' : ''}`;
  banner.textContent = task.blockedReason ? task.blockedReason
    : waiting.length ? `Starts after: ${waiting.map((w) => `${w.title} (${LABELS[w.status]})`).join(', ')}`
      : task.status === 'review' ? `${task.assignee} asks for review${task.reviewer ? ` by ${task.reviewer}` : ''}${task.reviewsRequired > 1 ? ` (${(task.approvals || []).length}/${task.reviewsRequired} approvals)` : ''}. Verified: ${task.verification || '—'}` : '';

  const lessons = task.lessons || [];
  $('#dlg-lessons').hidden = !lessons.length;
  $('#dlg-lessons').replaceChildren(el('strong', { textContent: `Lessons learned (${lessons.length})` }), el('ul', {}, lessons.map((l) => el('li', { title: l.body }, el('b', { textContent: l.title }), ` — ${l.body.split('\n')[0]}`))));

  draftCriteria = (task.criteria || []).map((c) => ({ ...c }));
  renderCriteria();
  $('#tab-criteria-n').textContent = draftCriteria.length ? `${draftCriteria.filter((c) => c.done).length}/${draftCriteria.length}` : '';
  $('#tab-comments-n').textContent = '';
  const comments = task.comments || [];
  const openQ = qs.filter((q) => !q.answer).length;
  $('#tab-comments-n').textContent = comments.length || openQ ? `${comments.length}${openQ ? ` · ❓${openQ}` : ''}` : '';
  $('#dlg-comments').replaceChildren(...(comments.length ? comments.map((c) => el('li', { className: `k-${c.kind || 'comment'}${c.body.startsWith('[⚠') ? ' flagged' : ''}` }, el('span', { className: 'm', textContent: `${c.actor} · ${ago(c.at)}${c.kind ? ` · ${c.kind.replace(/-/g, ' ')}` : ''}` }), el('div', { className: 'body', textContent: c.body })))
    : [el('li', { className: 'empty', textContent: 'No comments yet.' })]));
  $('#comment-new').disabled = isNew; $('#comment-add').disabled = isNew;

  const usage = task.usage || { tokens: 0, costUsd: 0 };
  $('#dlg-progress').replaceChildren(el('div', { className: 'kpis' },
    el('div', { className: 'kpi' }, el('div', { className: 'm', textContent: 'Progress' }), el('div', { className: 'v', textContent: task.progress == null ? '—' : `${task.progress}%` }), task.progressNote ? el('div', { className: 'm', textContent: task.progressNote }) : null),
    el('div', { className: 'kpi' }, el('div', { className: 'm', textContent: 'Cost' }), el('div', { className: 'v', textContent: money(usage.costUsd) }), task.budget?.costUsd !== undefined ? el('div', { className: 'm', textContent: `budget ${money(task.budget.costUsd)}` }) : null),
    el('div', { className: 'kpi' }, el('div', { className: 'm', textContent: 'Tokens' }), el('div', { className: 'v', textContent: tokens(usage.tokens) }), task.budget?.tokens !== undefined ? el('div', { className: 'm', textContent: `budget ${tokens(task.budget.tokens)}` }) : null),
    el('div', { className: 'kpi' }, el('div', { className: 'm', textContent: 'Claim' }), el('div', { className: 'v', textContent: task.leaseUntil ? until(task.leaseUntil) : '—' }), el('div', { className: 'm', textContent: task.assignee || 'unassigned' }))));
  const receipts = (task.receipts || []).slice().reverse();
  const sc = task.scope;
  $('#dlg-code').replaceChildren(...[
    task.worktree ? el('div', { className: 'm', textContent: `Branch ${task.worktree.branch} · ${task.worktree.path}` }) : null,
    sc ? el('div', { className: `receipt ${sc.ok ? 'passed' : 'failed'}` }, el('strong', { textContent: sc.ok ? `Scope OK: ${sc.changed.length} changed file(s), all inside the task` : 'Scope warning' }),
      sc.outOfScope.length ? el('div', { textContent: `Outside the task: ${sc.outOfScope.join(', ')}` }) : null,
      ...sc.foreign.map((f) => el('div', { textContent: `${f.files.join(', ')} belong(s) to ${f.agent} ("${f.title}")` })), el('div', { className: 'm', textContent: ago(sc.at) })) : null,
    task.protectedTouched?.length ? el('div', { className: 'receipt failed' }, el('strong', { textContent: '🛡 Protected paths changed: a human must approve' }), el('div', { textContent: task.protectedTouched.join(', ') })) : null,
    ...receipts.slice(0, 3).map((r) => el('div', { className: `receipt ${r.status}` },
      el('strong', { textContent: `Checks ${r.status} on ${r.sha.slice(0, 10)}${r.dirty ? ' (with uncommitted changes)' : ''}` }), el('span', { className: 'm', textContent: ` · ${ago(r.finishedAt || r.startedAt)} · started by ${r.by}` }),
      ...(r.results || []).map((x) => el('div', {}, `${x.exitCode === 0 ? '✔' : '✗'} ${x.name} `, el('span', { className: 'm', textContent: `exit ${x.exitCode} · ${(x.durationMs / 1000).toFixed(1)}s` }), x.exitCode !== 0 ? el('pre', { textContent: x.tail.slice(-1500) }) : null)))),
    task.id && task.status !== 'done' && task.worktree ? el('button', { type: 'button', className: 'ghost', textContent: 'Run checks now', onclick: () => act(() => api(`/api/tasks/${task.id}/checks`, { method: 'POST', body: {} })) }) : null,
  ].filter(Boolean));
  const metrics = Object.entries(task.metrics || {}).filter(([, pts]) => Array.isArray(pts));
  $('#dlg-metrics').replaceChildren(...(metrics.length ? metrics.map(([k, pts]) => el('div', { className: 'metric' }, el('div', { className: 'm', textContent: `${k} · ${pts.length} points` }), el('div', { className: 'v', textContent: fmt(pts[pts.length - 1].v) }), sparkline(pts)))
    : [el('p', { className: 'm', textContent: 'No metrics reported. Agents and training jobs send them with report_progress (e.g. loss, accuracy, tests passed).' })]));

  const history = [...(task.handoffs || []).map((h) => ({ at: h.at, text: `${h.from} → ${h.to || 'board'}: ${h.summary}${h.nextSteps ? `\nNext: ${h.nextSteps}` : ''}` }))];
  if (task.createdAt) history.unshift({ at: task.createdAt, text: `Created by ${task.createdBy}` });
  if (task.reviewedBy) history.push({ at: task.updatedAt, text: `Approved by ${task.reviewedBy}` });
  $('#dlg-history').replaceChildren(...history.map((h) => el('li', {}, el('span', { className: 'm', textContent: ago(h.at) }), el('div', { className: 'body', textContent: h.text }))));

  $('#dlg-delete').hidden = isNew;
  $('#dlg-approve').hidden = task.status !== 'review';
  $('#dlg-reject').hidden = task.status !== 'review';
}

function renderCriteria() {
  $('#dlg-criteria').replaceChildren(...(draftCriteria.length ? draftCriteria.map((c, i) => el('li', { className: c.done ? 'done' : '' },
    el('input', { type: 'checkbox', checked: c.done, ariaLabel: `Done: ${c.text}`, onchange: (e) => toggleCriterion(i, e.target.checked) }),
    el('span', { className: 'grow', textContent: c.text }),
    c.by ? el('span', { className: 'm', textContent: c.by }) : null,
    el('button', { type: 'button', className: 'ghost icon', textContent: '✕', ariaLabel: 'Remove', onclick: () => { draftCriteria.splice(i, 1); renderCriteria(); } })))
    : [el('li', { className: 'empty', textContent: 'No acceptance criteria. Add what "done" means.' })]));
}

async function toggleCriterion(i, done) {
  const c = draftCriteria[i];
  if (!editing?.id || !c.id) { c.done = done; renderCriteria(); return; }
  try {
    const t = await api(`/api/tasks/${editing.id}/criteria`, { method: 'POST', body: { criterion: c.id, done } });
    editing = { ...editing, ...t };
    draftCriteria = t.criteria.map((x) => ({ ...x }));
    renderCriteria();
  } catch (err) { showError(err); renderCriteria(); }
}

async function openTask(id) {
  try {
    editing = id ? await api(`/api/tasks/${id}`) : { title: $('#task-title').value, priority: Number($('#task-priority').value) };
  } catch (err) { showError(err); return; }
  fillDialog(editing);
  selectTab('details');
  $('#task-dialog').showModal();
}

function formBody(f) {
  const listOf = (s, sep) => s.split(sep).map((x) => x.trim()).filter(Boolean);
  const budget = {};
  if (f.budgetCost.value !== '') budget.costUsd = Number(f.budgetCost.value);
  if (f.budgetTokens.value !== '') budget.tokens = Number(f.budgetTokens.value);
  return {
    title: f.title.value, description: f.description.value, priority: Number(f.priority.value),
    files: listOf(f.files.value, '\n'), skills: listOf(f.skills.value, ','), review: f.review.checked,
    dependsOn: $$('#dlg-deps input:checked').map((i) => i.value),
    criteria: draftCriteria.map((c) => c.text), budget: Object.keys(budget).length ? budget : null,
  };
}

$('#task-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  const body = formBody(f);
  const t = editing;
  const run = t.id
    ? () => api(`/api/tasks/${t.id}`, { method: 'PATCH', body: { ...body, version: t.version, status: f.status.value, assignee: f.assignee.value.trim() || null } })
    : () => api('/api/tasks', { method: 'POST', body });
  act(run).then((ok) => { if (ok) { $('#task-dialog').close(); if (!t.id) $('#task-title').value = ''; } });
});
$('#crit-add').addEventListener('click', () => {
  const input = $('#crit-new');
  if (!input.value.trim()) return;
  draftCriteria.push({ text: input.value.trim(), done: false });
  input.value = '';
  renderCriteria();
});
$('#crit-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#crit-add').click(); } });
$('#comment-add').addEventListener('click', async () => {
  const body = $('#comment-new').value.trim();
  if (!body || !editing?.id) return;
  try {
    await api(`/api/tasks/${editing.id}/comments`, { method: 'POST', body: { body } });
    $('#comment-new').value = '';
    editing = await api(`/api/tasks/${editing.id}`);
    fillDialog(editing); selectTab('comments');
  } catch (err) { showError(err); }
});
async function answer(taskId, qid, text) {
  if (!text.trim()) return;
  try {
    await api(`/api/tasks/${taskId}/answers`, { method: 'POST', body: { question: qid, answer: text } });
    if (editing?.id === taskId) { editing = await api(`/api/tasks/${taskId}`); fillDialog(editing); selectTab('comments'); }
    refresh(true);
  } catch (err) { showError(err); }
}
$('#question-add').addEventListener('click', async () => {
  const text = $('#comment-new').value.trim();
  if (!text || !editing?.id) return;
  const m = text.match(/^@(\S+)\s+(.+)$/s);
  try {
    await api(`/api/tasks/${editing.id}/questions`, { method: 'POST', body: { to: m ? m[1] : 'anyone', question: m ? m[2] : text } });
    $('#comment-new').value = '';
    editing = await api(`/api/tasks/${editing.id}`); fillDialog(editing); selectTab('comments');
  } catch (err) { showError(err); }
});
$('#split-go').addEventListener('click', async () => {
  const parts = $('#split-parts').value.split(';').map((x) => x.trim()).filter(Boolean);
  if (!parts.length || !editing?.id) return;
  try {
    await api(`/api/tasks/${editing.id}/split`, { method: 'POST', body: { parts, sequential: $('#split-seq').checked } });
    $('#split-parts').value = '';
    editing = await api(`/api/tasks/${editing.id}`); fillDialog(editing);
  } catch (err) { showError(err); }
});
$('#dlg-resolve').addEventListener('click', () => {
  const note = prompt('What did you decide? (split, clarify, reassign, drop)') ?? '';
  act(() => api(`/api/tasks/${editing.id}/resolve`, { method: 'POST', body: { note } })).then((ok) => ok && $('#task-dialog').close());
});
$('#dlg-approve').addEventListener('click', () => act(() => api(`/api/tasks/${editing.id}/review`, { method: 'POST', body: { approve: true } })).then((ok) => ok && $('#task-dialog').close()));
$('#dlg-reject').addEventListener('click', () => {
  const comment = $('#comment-new').value.trim() || prompt('What must change?');
  if (!comment) return;
  act(() => api(`/api/tasks/${editing.id}/review`, { method: 'POST', body: { approve: false, comment } })).then((ok) => { if (ok) { $('#comment-new').value = ''; $('#task-dialog').close(); } });
});
const closeTask = () => $('#task-dialog').close();
$('#dlg-cancel').addEventListener('click', closeTask);
$('#dlg-x').addEventListener('click', closeTask);
$('#dlg-delete').addEventListener('click', () => {
  if (!confirm(`Delete "${editing.title}"?`)) return;
  const { id, version } = editing;
  $('#task-dialog').close();
  act(() => api(`/api/tasks/${id}?version=${version}`, { method: 'DELETE' }));
});
$('#task-dialog').addEventListener('close', () => { editing = null; if (pending) refresh(); });

// ---- quick add, notes, filters -----------------------------------------------------

$('#new-task').addEventListener('submit', (e) => {
  e.preventDefault();
  const title = e.target.title.value;
  const priority = Number(e.target.priority.value);
  e.target.title.value = '';
  act(() => api('/api/tasks', { method: 'POST', body: { title, priority } }));
});
$('#new-task-more').addEventListener('click', () => openTask(null));
$('#new-note').addEventListener('submit', (e) => {
  e.preventDefault();
  const body = { title: e.target.title.value, body: e.target.body.value };
  e.target.reset();
  act(() => api('/api/notes', { method: 'POST', body }));
});
let searchTimer;
$('#note-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => refresh(true), 200); });
$('#filter').addEventListener('input', () => $('#board').replaceChildren(...STATUSES.map(column)));
$('#filter-agent').addEventListener('change', () => $('#board').replaceChildren(...STATUSES.map(column)));

document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]') || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
  if (e.key === 'n') { e.preventDefault(); $('#task-title').focus(); }
  if (e.key === '/') { e.preventDefault(); $('#filter').focus(); }
});

// ---- code and checks -------------------------------------------------------------------

async function renderCode() {
  const c = await api('/api/code');
  $('#code-summary').textContent = c.repo ? `${c.repo.path.split(/[\\/]/).pop()} · ${c.checks.length} check(s)` : 'Repository and checks (not set)';
  $('#radar-run').hidden = !c.repo;
  if (!$('#code-edit').open) {
    $('#code-repo').value = c.repo?.path || '';
    $('#code-base').value = c.repo?.base || '';
    $('#code-checks').value = c.checks.map((x) => x.command).join('\n');
    $('#code-protected').value = c.protected.join('\n');
  }
}
$('#code-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const repo = $('#code-repo').value.trim();
  const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);
  const ok = await act(async () => {
    if (repo) await api('/api/code/repo', { method: 'PUT', body: { dir: repo, base: $('#code-base').value.trim() || undefined } });
    const cmds = lines($('#code-checks').value);
    await api('/api/code/checks', { method: 'PUT', body: { checks: cmds.map((command, i) => ({ name: cmds.length > 1 ? `check ${i + 1}` : 'checks', command })), protectedPaths: lines($('#code-protected').value) } });
  });
  if (ok) $('#code-edit').open = false;
});
$('#radar-run').addEventListener('click', async () => {
  try {
    const r = await api('/api/radar');
    $('#radar').replaceChildren(...(r.conflicts.length ? r.conflicts.map((c) => el('li', {}, el('strong', { textContent: `⚠ ${c.files.join(', ')}` }), ` · ${c.a.agent} (${c.a.title}) and ${c.b.agent} (${c.b.title})`))
      : [el('li', { className: 'empty', textContent: `${r.branches.length} active branch(es), no overlapping changes.` })]));
  } catch (err) { showError(err); }
});

// ---- guard -------------------------------------------------------------------------

async function renderGuard() {
  const g = await api('/api/guard?limit=8');
  $('#guard-section').hidden = !g.events.length && !g.quarantined.length;
  $('#quarantine').replaceChildren(...g.quarantined.map((n) => el('li', { className: 'proposal' },
    el('span', { className: 'kind', textContent: `Quarantined · ${n.author}` }), el('strong', { textContent: n.title }), el('span', { className: 'body', textContent: n.body }),
    el('span', { className: 'm', textContent: (n.reasons || []).join('; ') }),
    el('span', { className: 'row' },
      el('button', { type: 'button', className: 'ghost', textContent: 'Release', title: 'It is fine: show it to agents', onclick: () => act(() => api(`/api/notes/${n.id}/release`, { method: 'POST', body: {} })) }),
      el('button', { type: 'button', className: 'danger', textContent: 'Remove', onclick: () => act(() => api(`/api/notes/${n.id}/remove`, { method: 'POST', body: {} })) })))));
  $('#guard-log').replaceChildren(...g.events.map((e) => el('li', {}, el('strong', { textContent: e.secrets.length ? `🔑 ${e.secrets.join(', ')} removed` : '⚠ flagged' }), ` · ${e.actor} in ${e.where} `, el('span', { className: 'm', textContent: ago(e.at) }))));
}

// ---- team, goal and the human inbox ------------------------------------------------

// A one-time, polite thank-you once the board has done some real work. Dismissed
// (or followed) once, it never comes back in this browser.
const STAR_AFTER_DONE = 5;
const starAsked = () => { try { return localStorage.getItem('starAsked') === '1'; } catch { return true; } };
const starDone = () => { try { localStorage.setItem('starAsked', '1'); } catch { /* storage blocked */ } $('#star-banner').hidden = true; };
$('#star-dismiss').addEventListener('click', starDone);
$('#star-banner .star-cta').addEventListener('click', starDone);
function renderStar(s) {
  const show = s.counts.done >= STAR_AFTER_DONE && !starAsked();
  $('#star-banner').hidden = !show;
  if (show) $('#star-text').textContent = `🎉 Your agents finished ${s.counts.done} tasks with AgentHaven. It is free and open source; if it helps you, a star on GitHub helps other people find it.`;
}

function renderTeam(s) {
  renderStar(s);
  const bar = $('#goal-bar');
  bar.hidden = !s.goal && !s.complete;
  bar.className = `goal-bar${s.complete ? ' done' : ''}`;
  bar.replaceChildren(...[
    ...(s.goal ? [el('strong', { textContent: 'Goal' }), el('span', { textContent: s.goal.text }), s.goal.doneWhen ? el('span', { className: 'm', textContent: `· done when: ${s.goal.doneWhen}` }) : null] : []),
    s.complete ? el('strong', { textContent: '✅ Every task is done' }) : null,
  ].filter(Boolean));
  $('#mode-agents').checked = s.agentsOnly;
  const sel = $('#lead');
  if (document.activeElement !== sel) {
    sel.replaceChildren(el('option', { value: '', textContent: s.lead ? '' : 'nobody' }), ...agents.filter((a) => a.kind !== 'human').map((a) => el('option', { value: a.name, textContent: a.name, selected: a.name === s.lead })));
    if (s.lead && !agents.some((a) => a.name === s.lead)) sel.append(el('option', { value: s.lead, textContent: s.lead, selected: true }));
  }
  if (!$('#goal-edit').open) { $('#goal-text').value = s.goal?.text || ''; $('#goal-done').value = s.goal?.doneWhen || ''; }
}

async function renderInbox() {
  const r = await api('/api/inbox?markRead=false');
  const items = [
    ...r.escalations.map((t) => el('li', {}, el('span', { className: 'kind', textContent: '⚠ Escalated' }), el('a', { href: '#', textContent: t.title, onclick: (e) => { e.preventDefault(); openTask(t.id); } }), el('span', { className: 'm', textContent: t.reason }))),
    ...r.questions.map((q) => el('li', {}, el('span', { className: 'kind', textContent: `❓ ${q.from} asks` }), el('span', { textContent: q.text }), el('span', { className: 'm', textContent: q.title }),
      el('span', { className: 'row' }, el('input', { placeholder: 'Answer', id: `ia-${q.id}` }), el('button', { type: 'button', textContent: 'Answer', onclick: () => answer(q.task, q.id, $(`#ia-${q.id}`).value) })))),
    ...r.reviews.map((t) => el('li', {}, el('span', { className: 'kind', textContent: `👀 Review · ${t.by}` }), el('a', { href: '#', textContent: t.title, onclick: (e) => { e.preventDefault(); openTask(t.id); } }), t.verification ? el('span', { className: 'm', textContent: `Verified: ${t.verification}` }) : null)),
    ...r.messages.slice(-8).reverse().map((m) => el('li', {}, el('span', { className: 'kind', textContent: `${m.kind} · ${m.from}` }), el('span', { textContent: m.body }), el('span', { className: 'm', textContent: ago(m.at) }))),
  ];
  $('#inbox').replaceChildren(...(items.length ? items : [el('li', { className: 'empty', textContent: 'Nothing needs you.' })]));
  $('#inbox-count').hidden = !r.count;
  $('#inbox-count').textContent = String(r.count);
}
$('#inbox-count').addEventListener('click', () => act(() => api('/api/inbox')));
$('#inbox-count').title = 'Mark messages as read';
$('#mode-agents').addEventListener('change', (e) => act(() => api('/api/mode', { method: 'PATCH', body: { agentsOnly: e.target.checked } })));
$('#lead').addEventListener('change', (e) => { if (e.target.value) act(() => api('/api/lead', { method: 'POST', body: { agent: e.target.value } })); });
$('#goal-form').addEventListener('submit', (e) => {
  e.preventDefault();
  act(() => api('/api/goal', { method: 'PUT', body: { text: $('#goal-text').value.trim(), doneWhen: $('#goal-done').value.trim() } })).then(() => { $('#goal-edit').open = false; });
});

// ---- dreams -------------------------------------------------------------------------

const KIND_LABEL = { lesson: 'Lesson', task: 'Follow-up task', 'merge-notes': 'Merge notes', 'retire-note': 'Retire note', 'agent-tip': 'Agent tip' };
async function renderDreams() {
  const r = await api('/api/dreams?limit=10');
  const open = r.dreams.flatMap((d) => d.proposals.filter((p) => p.status === 'proposed').map((p) => ({ ...p, by: d.by })));
  const last = r.dreams[0];
  $('#dream-state').textContent = last ? `Last dream ${ago(last.at)} by ${last.by}: ${last.summary}` : 'No dreams yet. The dreamer looks back at reviews sent back, expired claims, budgets and notes, and proposes lessons.';
  $('#proposals').replaceChildren(...(open.length ? open.map((p) => el('li', { className: 'proposal' },
    el('span', { className: 'kind', textContent: `${KIND_LABEL[p.kind] || p.kind}${p.agent ? ` · ${p.agent}` : ''} · by ${p.by}` }),
    el('strong', { textContent: p.title }),
    el('span', { className: 'body', textContent: p.body }),
    p.evidence?.length ? el('span', { className: 'm', textContent: `Evidence: ${p.evidence.map((id) => tasks.find((t) => t.id === id)?.title || id).join(', ')}` }) : null,
    el('span', { className: 'row' },
      el('button', { type: 'button', className: 'ok', textContent: 'Apply', onclick: () => act(() => api(`/api/dreams/proposals/${p.id}/apply`, { method: 'POST', body: {} })) }),
      el('button', { type: 'button', className: 'ghost', textContent: 'Dismiss', onclick: () => act(() => api(`/api/dreams/proposals/${p.id}/dismiss`, { method: 'POST', body: {} })) }))))
    : [el('li', { className: 'empty', textContent: 'No open proposals.' })]));
  if (document.activeElement !== $('#dream-every')) $('#dream-every').value = r.settings.everyHours;
  $('#dream-auto').checked = r.settings.autoApply;
  $('#dream-agent').checked = r.settings.agentTask;
}
const saveDreamSettings = () => act(() => api('/api/dreams/settings', { method: 'PATCH', body: { autoApply: $('#dream-auto').checked, agentTask: $('#dream-agent').checked, everyHours: Number($('#dream-every').value || 0) } }));
$('#dream-auto').addEventListener('change', saveDreamSettings);
$('#dream-agent').addEventListener('change', saveDreamSettings);
$('#dream-every').addEventListener('change', saveDreamSettings);
$('#dream-now').addEventListener('click', () => act(() => api('/api/dreams', { method: 'POST', body: {} })));
$('#dream-prompt').addEventListener('click', async () => {
  try {
    const { prompt } = await api('/api/dreams/prompt');
    await navigator.clipboard.writeText(prompt);
    $('#dream-prompt').textContent = 'Copied';
    setTimeout(() => { $('#dream-prompt').textContent = 'Copy instructions for a Claude dreaming agent'; }, 1500);
  } catch (err) { showError(err); }
});

// ---- workspaces and file sharing --------------------------------------------------

async function loadWorkspaces(extra) {
  const names = await (await fetch('/api/workspaces')).json();
  if (extra && !names.includes(extra)) names.push(extra);
  if (!names.includes(workspace)) workspace = 'default';
  $('#workspace').replaceChildren(...names.map((n) => el('option', { value: n, textContent: n, selected: n === workspace })));
}
const remember = () => { try { localStorage.setItem('workspace', workspace); } catch { /* storage blocked */ } };
$('#workspace').addEventListener('change', (e) => { workspace = e.target.value; remember(); connect(); refresh(true); });
$('#new-workspace').addEventListener('click', () => $('#ws-dialog').showModal());
$('#ws-cancel').addEventListener('click', () => $('#ws-dialog').close());
$('#ws-form').addEventListener('submit', (e) => {
  workspace = e.target.name.value;
  remember();
  e.target.reset();
  setTimeout(() => loadWorkspaces(workspace).then(() => { connect(); refresh(true); }));
});

function showShare(state) {
  $('#share-state').textContent = state.dir ? `Shared at ${state.dir}${state.linked ? ' · syncing' : ''}` : 'Not shared yet.';
  $('#share-instr-wrap').hidden = !state.instructions;
  $('#share-instr').value = state.instructions || '';
  $('#share-unlink').hidden = !state.dir;
  $('#share-copy').hidden = !state.instructions;
  if (state.dir) $('#share-form').dir.value = state.dir;
}
$('#share-files').addEventListener('click', async () => {
  try { showShare(await api('/api/workboard')); } catch (err) { showError(err); }
  $('#share-dialog').showModal();
});
$('#share-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { showShare(await api('/api/workboard', { method: 'POST', body: { dir: e.target.dir.value.trim() } })); } catch (err) { $('#share-state').textContent = err.message; }
});
$('#share-unlink').addEventListener('click', async () => { try { showShare(await api('/api/workboard', { method: 'DELETE' })); } catch (err) { showError(err); } });
$('#share-copy').addEventListener('click', () => navigator.clipboard?.writeText($('#share-instr').value).then(() => { $('#share-copy').textContent = 'Copied'; setTimeout(() => { $('#share-copy').textContent = 'Copy instructions'; }, 1500); }));
$('#share-cancel').addEventListener('click', () => $('#share-dialog').close());

// ---- updates (desktop app only) ------------------------------------------------------

const updates = window.agenthavenDesktop?.updates;
let upd = null;
let updHiddenFor = '';
const mb = (n) => `${(n / 1048576).toFixed(n >= 10485760 ? 0 : 1)} MB`;

function updateView(s) {
  const v = s.version ? `AgentHaven ${s.version}` : 'AgentHaven';
  if (s.status === 'downloading') {
    const parts = [`${s.percent || 0}%`];
    if (s.total) parts.push(`${mb(s.transferred)} of ${mb(s.total)}`);
    if (s.bytesPerSecond) parts.push(`${mb(s.bytesPerSecond)}/s`);
    return { title: `Downloading ${v}…`, detail: parts.join(' · '), progress: s.percent || 0 };
  }
  if (s.status === 'downloaded' && s.manualInstall) return { title: `${v} is downloaded`, detail: 'Open it, drag AgentHaven onto Applications and choose Replace. Your boards are kept.', action: 'Open and quit', ready: true };
  if (s.status === 'downloaded') return { title: `${v} is ready to install`, detail: 'Restart to update. Your boards are kept; it also installs the next time you quit.', action: 'Restart and update', ready: true };
  if (s.status === 'available') return { title: `${v} is available`, detail: s.manualInstall ? 'Download the new version to your Downloads folder and install it with one drag.' : 'A new version is available.', action: s.manualInstall ? 'Download' : 'Download and install' };
  if (s.status === 'error' && (s.manualCheck || s.version)) return { title: 'Update failed', detail: s.error || '', action: 'Try again', error: true };
  if (s.justUpdatedFrom) return { title: `Updated to AgentHaven ${s.currentVersion}`, detail: `You were on ${s.justUpdatedFrom}. See what changed in this version.`, action: 'OK', whatsNew: true, ready: true };
  return null;
}

function updateAction(s) {
  if (s.justUpdatedFrom && !['available', 'downloading', 'downloaded', 'error'].includes(s.status)) return updates.dismissWhatsNew();
  if (s.status === 'downloaded') return updates.install();
  if (s.status === 'available') return updates.download();
  if (s.status === 'error') return updates.check();
  return null;
}

function renderUpdates(s) {
  upd = s;
  if (!s || s.status === 'unsupported') return;
  const view = updateView(s);
  const key = `${s.status}:${s.version || s.justUpdatedFrom || ''}`;
  const banner = $('#update-banner');
  banner.hidden = !view || updHiddenFor === key;
  if (view) {
    banner.className = `update-banner${view.ready ? ' ready' : ''}${view.error ? ' error' : ''}`;
    $('#update-icon').textContent = view.error ? '!' : view.ready ? '✓' : '⬆';
    $('#update-title').textContent = view.title;
    $('#update-detail').textContent = view.detail;
    $('#update-progress').hidden = view.progress == null;
    $('#update-bar').style.width = `${view.progress || 0}%`;
    $('#update-action').hidden = !view.action;
    $('#update-action').textContent = view.action || '';
    $('#update-notes').hidden = !(s.notes || view.whatsNew);
  }
  const pending = ['available', 'downloading', 'downloaded'].includes(s.status);
  const pill = $('#update-btn');
  pill.hidden = false;
  pill.classList.toggle('hot', pending);
  pill.textContent = s.status === 'downloaded' ? '⬆ Restart to update' : s.status === 'downloading' ? `⬆ ${s.percent || 0}%` : pending ? `⬆ ${s.version}` : `v${s.currentVersion}`;
  pill.title = pending ? `${view?.title || 'Update'}. Click for details.` : 'Version and updates';

  $('#upd-current').textContent = `Installed: ${s.currentVersion}`;
  $('#upd-status').textContent = view ? `${view.title}. ${view.detail}`
    : s.status === 'checking' ? 'Checking for updates…'
      : s.status === 'up-to-date' ? `You have the latest version.${s.checkedAt ? ` Checked ${ago(s.checkedAt)}.` : ''}`
        : s.status === 'error' ? `Last check failed: ${s.error}` : 'Not checked yet.';
  $('#upd-progress').hidden = s.status !== 'downloading';
  $('#upd-bar').style.width = `${s.percent || 0}%`;
  $('#upd-notes').hidden = !s.notes;
  $('#upd-notes').textContent = s.notes ? `What's new in ${s.version}\n\n${s.notes}` : '';
  $('#upd-mac').hidden = !(s.manualInstall && pending);
  $('#upd-auto').checked = s.autoCheck;
  $('#upd-skip').hidden = !(s.version && ['available', 'downloading', 'downloaded'].includes(s.status));
  $('#upd-check').disabled = ['checking', 'downloading'].includes(s.status);
  $('#upd-check').textContent = s.status === 'checking' ? 'Checking…' : 'Check now';
  const act = pending && view?.action && !view.whatsNew;
  $('#upd-action').hidden = !act;
  $('#upd-action').textContent = act ? view.action : '';
}

async function updCall(fn) {
  try { const s = await fn(); if (s && typeof s === 'object') renderUpdates(s); } catch (err) { showError(err); }
}

if (updates) {
  updates.onState(renderUpdates);
  updates.get().then(renderUpdates).catch(() => {});
  $('#update-btn').addEventListener('click', () => { if (upd) renderUpdates(upd); $('#update-dialog').showModal(); });
  $('#update-action').addEventListener('click', () => updCall(() => updateAction(upd)));
  $('#upd-action').addEventListener('click', () => updCall(() => updateAction(upd)));
  $('#update-later').addEventListener('click', () => {
    updHiddenFor = `${upd.status}:${upd.version || upd.justUpdatedFrom || ''}`;
    $('#update-banner').hidden = true;
    if (upd.justUpdatedFrom && !upd.version) updCall(() => updates.dismissWhatsNew());
  });
  $('#update-notes').addEventListener('click', () => {
    if (upd.notes) { renderUpdates(upd); $('#update-dialog').showModal(); } else updates.openReleases();
  });
  $('#upd-check').addEventListener('click', () => updCall(() => updates.check()));
  $('#upd-skip').addEventListener('click', () => updCall(() => updates.skip()));
  $('#upd-auto').addEventListener('change', (e) => updCall(() => updates.setAutoCheck(e.target.checked)));
  $('#upd-releases').addEventListener('click', () => updates.openReleases());
}

// ---- agent connections ---------------------------------------------------------------

const CONN_TEXT = {
  connected: ['✓', 'Connected', 'ok'], plugin: ['✓', 'Connected through the AgentHaven plugin', 'ok'],
  outdated: ['↻', 'Points to an old copy of AgentHaven: reconnect', 'warn'], 'not-connected': ['○', 'Installed, not connected', ''],
  'broken-config': ['!', 'Its MCP settings file cannot be read', 'bad'], 'not-installed': ['·', 'Not found on this computer', ''],
};
let conns = null;

function seenAuto() { try { return localStorage.getItem('connectSeen'); } catch { return null; } }
function markAutoSeen(at) { try { localStorage.setItem('connectSeen', at); } catch { /* storage blocked */ } $('#connect-banner').hidden = true; }

function renderConnections(c) {
  conns = c;
  const live = c.clients.filter((x) => ['connected', 'plugin'].includes(x.state));
  const fix = c.clients.filter((x) => ['outdated', 'not-connected', 'broken-config'].includes(x.state) && !c.off.includes(x.id));
  const btn = $('#connect-btn');
  btn.classList.toggle('on', live.length > 0 && !fix.length);
  btn.classList.toggle('warn', fix.length > 0);
  $('#connect-label').textContent = live.length ? `${live.length} agent${live.length === 1 ? '' : 's'} connected` : 'Connect agents';
  btn.title = fix.length ? `${fix.map((x) => x.label).join(', ')}: not connected yet` : 'Agent apps connected to this board';

  $('#connect-summary').textContent = `${live.length} of ${c.clients.filter((x) => x.installed).length} installed`;
  $('#connect-notice').hidden = !c.notice;
  $('#connect-notice').textContent = c.notice || '';
  $('#connect-auto').checked = c.auto && c.managed;
  $('#connect-auto').disabled = !c.managed;
  $('#connect-auto-label').textContent = c.managed
    ? 'Keep my agents connected automatically: connect new agent apps and repair connections after AgentHaven moves or updates'
    : 'Automatic connection runs in the AgentHaven desktop app. Here, use the buttons or run agenthaven connect.';
  const order = (x) => (x.installed ? 0 : 1);
  $('#connect-list').replaceChildren(...[...c.clients].sort((a, b) => order(a) - order(b)).map((x) => {
    const [icon, text, tone] = CONN_TEXT[x.state] || ['?', x.state, ''];
    const off = c.off.includes(x.id) && x.state === 'not-connected';
    const acts = [];
    if (['not-connected', 'outdated'].includes(x.state)) acts.push(el('button', { type: 'button', textContent: x.state === 'outdated' ? 'Reconnect' : 'Connect', onclick: () => connCall('POST', { client: x.id }, `${x.label} connected. Restart it once.`) }));
    if (x.state === 'not-installed') acts.push(el('button', { type: 'button', className: 'ghost', textContent: 'Connect anyway', title: 'Write the config even though the app was not found', onclick: () => connCall('POST', { client: x.id }, `${x.label} connected.`) }));
    if (['connected', 'outdated'].includes(x.state)) acts.push(el('button', { type: 'button', className: 'ghost', textContent: 'Disconnect', onclick: () => connCall('DELETE', x.id, `${x.label} disconnected. AgentHaven will not reconnect it by itself.`) }));
    return el('li', { className: `${tone}${off ? ' off' : ''}` },
      el('span', { className: 'ic', textContent: icon }),
      el('strong', { textContent: x.label }),
      el('div', { className: 'acts' }, acts),
      el('span', { className: `st ${tone}`, textContent: off ? 'Disconnected by you' : x.reason && x.state === 'not-connected' ? x.reason : x.state === 'broken-config' ? `${text}: fix it, then reconnect` : text, title: x.error || x.file }));
  }));

  // First-run card: the installed apps as chips.
  $('#onboard-connect').replaceChildren(...c.clients.filter((x) => x.installed).map((x) => el('span', { className: 'chip', textContent: `${(CONN_TEXT[x.state] || ['?'])[0]} ${x.label}` })));
  $('#onboard-connect-all').hidden = !fix.length && live.length > 0;

  // After AgentHaven connected apps by itself: say so once.
  const done = (c.lastAuto?.results || []).filter((r) => ['connected', 'repaired'].includes(r.action));
  const show = done.length > 0 && seenAuto() !== c.lastAuto.at;
  $('#connect-banner').hidden = !show;
  if (show) {
    const names = done.map((r) => r.label);
    $('#connect-banner-title').textContent = `AgentHaven ${done.some((r) => r.action === 'connected') ? 'connected itself to' : 'repaired the connection with'} ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]}`;
    $('#connect-banner-detail').textContent = 'Restart those apps once to load the AgentHaven tools, then ask: "Take the next task from the AgentHaven board."';
  }
}

async function loadConnections() {
  try { renderConnections(await api('/api/connections')); } catch { /* older server */ }
}

async function connCall(method, arg, okText) {
  $('#connect-msg').textContent = 'Working…';
  try {
    const r = method === 'DELETE' ? await api(`/api/connections/${encodeURIComponent(arg)}`, { method })
      : await api('/api/connections', { method, body: arg });
    renderConnections(r);
    const errors = (r.results || []).filter((x) => x.action === 'error');
    const done = (r.results || []).filter((x) => x.action !== 'error');
    $('#connect-msg').textContent = errors.length ? errors.map((x) => `${x.label}: ${x.error}`).join(' ')
      : okText || (done.length ? `Connected ${done.map((x) => x.label).join(', ')}. Restart them once.` : 'Every installed agent app is already connected.');
  } catch (err) { $('#connect-msg').textContent = err.message; }
}

$('#connect-btn').addEventListener('click', () => { $('#connect-msg').textContent = ''; loadConnections(); $('#connect-dialog').showModal(); });
$('#connect-all').addEventListener('click', () => connCall('POST', { all: true }));
$('#onboard-connect-all').addEventListener('click', () => { connCall('POST', { all: true }); $('#connect-dialog').showModal(); });
$('#connect-auto').addEventListener('change', (e) => connCall('PATCH', { auto: e.target.checked }, e.target.checked ? 'AgentHaven keeps your agents connected.' : 'Automatic connection is off.'));
$('#connect-banner-ok').addEventListener('click', () => markAutoSeen(conns.lastAuto.at));
$('#connect-banner-show').addEventListener('click', () => { markAutoSeen(conns.lastAuto.at); $('#connect-dialog').showModal(); });
loadConnections();
setInterval(() => { if (!document.hidden) loadConnections(); }, 60000);

loadWorkspaces().then(() => { connect(); return refresh(true); }).catch(showError);

// Desktop app: a click on a notification opens that task, in its own workspace.
window.agenthavenDesktop?.onOpenTask?.(async ({ workspace: ws, taskId }) => {
  try {
    if (ws && ws !== workspace) {
      workspace = ws;
      remember();
      await loadWorkspaces(ws);
      connect();
      await refresh(true);
    }
    if (taskId) await openTask(taskId);
  } catch (err) { showError(err); }
});
