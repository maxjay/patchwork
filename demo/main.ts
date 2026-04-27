import { Engine, CopilotSession } from '../src/index.js';
import type { Op, DiffEntry } from '../src/index.js';

// ─── Initial config ──────────────────────────────────────────────────────────

const INITIAL_CONFIG = {
  appName: 'my-service',
  timeout: 30,
  retries: 3,
  server: {
    host: 'localhost',
    port: 8080,
  },
};

const engine = new Engine(INITIAL_CONFIG);
const baseSnapshot = JSON.parse(JSON.stringify(INITIAL_CONFIG));

// ─── DOM refs ────────────────────────────────────────────────────────────────

const $editor = document.getElementById('editor')!;
const $undoBtn = document.getElementById('undo-btn')!;
const $redoBtn = document.getElementById('redo-btn')!;
const $addKey = document.getElementById('add-key') as HTMLInputElement;
const $addValue = document.getElementById('add-value') as HTMLInputElement;
const $addSubmit = document.getElementById('add-submit')!;
const $copilotInactive = document.getElementById('copilot-inactive')!;
const $copilotActive = document.getElementById('copilot-active')!;
const $copilotProposals = document.getElementById('copilot-proposals')!;
const $startCopilot = document.getElementById('start-copilot')!;
const $approveAll = document.getElementById('approve-all')!;
const $declineAll = document.getElementById('decline-all')!;
const $endSession = document.getElementById('end-session')!;
const $debugBase = document.getElementById('debug-base')!;
const $debugUserOps = document.getElementById('debug-user-ops')!;
const $debugCopilotOps = document.getElementById('debug-copilot-ops')!;
const $debugCurrent = document.getElementById('debug-current')!;
const $debugVersion = document.getElementById('debug-version')!;

// ─── Render ──────────────────────────────────────────────────────────────────

function render() {
  renderEditor();
  renderCopilot();
  renderDebug();
}

// ─── Editor ──────────────────────────────────────────────────────────────────

function renderEditor() {
  const current = engine.export() as Record<string, unknown>;
  const userOps = engine.diff();
  const copilotOps = engine.activeCopilotSession()?.diff() ?? [];

  const changedPaths = new Set(userOps.map((op) => op.path));
  const copilotPaths = new Set(copilotOps.map((op) => op.path));

  $editor.innerHTML = '';
  renderObject(current, '', 0, changedPaths, copilotPaths, userOps);
}

function renderObject(
  obj: Record<string, unknown>,
  prefix: string,
  depth: number,
  changedPaths: Set<string>,
  copilotPaths: Set<string>,
  userOps: Op[],
) {
  for (const [key, value] of Object.entries(obj)) {
    const path = `${prefix}/${key}`;

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      // Section header for nested objects
      const section = document.createElement('div');
      section.className = 'field-section';
      section.innerHTML = `${'&nbsp;'.repeat(depth * 4)}<span class="field-key">${esc(key)}</span><span class="field-colon">:</span>`;
      $editor.appendChild(section);
      renderObject(
        value as Record<string, unknown>,
        path,
        depth + 1,
        changedPaths,
        copilotPaths,
        userOps,
      );
    } else {
      const row = document.createElement('div');
      row.className = 'field-row';
      if (changedPaths.has(path)) row.classList.add('changed');
      if (copilotPaths.has(path)) row.classList.add('copilot-changed');

      const indent = '&nbsp;'.repeat(depth * 4);
      const typeClass = typeof value === 'string' ? 'type-string' : typeof value === 'number' ? 'type-number' : 'type-boolean';
      const displayValue = typeof value === 'string' ? value : JSON.stringify(value);

      row.innerHTML = `
        <span class="field-indent">${indent}</span>
        <span class="field-key">${esc(key)}</span>
        <span class="field-colon">:</span>
        <input class="field-value ${typeClass}" value="${esc(String(displayValue))}" data-path="${esc(path)}" data-original="${esc(String(displayValue))}" />
        <button class="field-remove" data-path="${esc(path)}">&times;</button>
      `;

      // Tooltip for changed fields
      if (changedPaths.has(path)) {
        const op = userOps.find((o) => o.path === path);
        if (op) {
          const tip = document.createElement('div');
          tip.className = 'tooltip';
          const prevStr = op.prev !== undefined ? esc(JSON.stringify(op.prev)) : '<i>none</i>';
          const valStr = op.value !== undefined ? esc(JSON.stringify(op.value)) : '<i>none</i>';
          tip.innerHTML = `<span class="base-val">${prevStr}</span> &rarr; <span class="curr-val">${valStr}</span>`;
          row.appendChild(tip);
        }
      }

      $editor.appendChild(row);
    }
  }
}

// ─── Editor events ───────────────────────────────────────────────────────────

$editor.addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  if (!input.dataset.path) return;

  const path = input.dataset.path;
  const raw = input.value.trim();
  const value = parseValue(raw);

  engine.propose({ kind: 'replace', path, value });
  render();
});

$editor.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('.field-remove') as HTMLElement | null;
  if (!btn?.dataset.path) return;

  engine.propose({ kind: 'remove', path: btn.dataset.path });
  render();
});

$undoBtn.addEventListener('click', () => { engine.undo(); render(); });
$redoBtn.addEventListener('click', () => { engine.redo(); render(); });

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
    e.preventDefault();
    engine.undo();
    render();
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && e.shiftKey) {
    e.preventDefault();
    engine.redo();
    render();
  }
});

function submitAddField() {
  const key = $addKey.value.trim();
  const rawValue = $addValue.value.trim();
  if (!key) return;

  const path = key.startsWith('/') ? key : `/${key}`;
  const value = parseValue(rawValue);

  engine.propose({ kind: 'add', path, value });
  $addKey.value = '';
  $addValue.value = '';
  $addKey.focus();
  render();
}

$addSubmit.addEventListener('click', submitAddField);

$addValue.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitAddField();
});

$addKey.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $addValue.focus();
});

// ─── Copilot ─────────────────────────────────────────────────────────────────

$startCopilot.addEventListener('click', () => {
  const session = engine.startCopilot();
  session.propose([
    { kind: 'replace', path: '/timeout', value: 60 },
    { kind: 'replace', path: '/retries', value: 5 },
    { kind: 'add', path: '/server/ssl', value: true },
  ]);
  render();
});

$approveAll.addEventListener('click', () => {
  engine.activeCopilotSession()?.approveAll();
  render();
});

$declineAll.addEventListener('click', () => {
  engine.activeCopilotSession()?.declineAll();
  render();
});

$endSession.addEventListener('click', () => {
  engine.activeCopilotSession()?.end();
  render();
});

$copilotProposals.addEventListener('click', (e) => {
  const btn = e.target as HTMLElement;
  const path = btn.dataset.path;
  if (!path) return;

  const session = engine.activeCopilotSession();
  if (!session) return;

  if (btn.classList.contains('btn-approve')) {
    session.approve(path);
  } else if (btn.classList.contains('btn-decline')) {
    session.decline(path);
  }
  render();
});

function renderCopilot() {
  const session = engine.activeCopilotSession();

  if (!session) {
    $copilotInactive.classList.remove('hidden');
    $copilotActive.classList.add('hidden');
    return;
  }

  $copilotInactive.classList.add('hidden');
  $copilotActive.classList.remove('hidden');

  const ops = session.diff();
  if (ops.length === 0) {
    $copilotProposals.innerHTML = '<div class="no-ops">No pending proposals</div>';
    return;
  }

  $copilotProposals.innerHTML = ops
    .map(
      (op) => `
      <div class="copilot-proposal">
        <span class="op-kind">${op.kind}</span>
        <span class="op-path">${esc(op.path)}</span>
        <span class="op-values">
          ${op.prev !== undefined ? `<span class="prev">${esc(JSON.stringify(op.prev))}</span>` : ''}
          ${op.prev !== undefined ? ' &rarr; ' : ''}
          ${op.value !== undefined ? `<span class="next">${esc(JSON.stringify(op.value))}</span>` : ''}
        </span>
        <button class="btn btn-small btn-approve" data-path="${esc(op.path)}">Approve</button>
        <button class="btn btn-small btn-decline" data-path="${esc(op.path)}">Decline</button>
      </div>
    `,
    )
    .join('');
}

// ─── Debug ───────────────────────────────────────────────────────────────────

function renderDebug() {
  $debugBase.textContent = JSON.stringify(baseSnapshot, null, 2);
  $debugCurrent.textContent = JSON.stringify(engine.export(), null, 2);
  $debugVersion.textContent = `version: ${engine.version}`;

  // User ops
  const userOps = engine.diff();
  if (userOps.length === 0) {
    $debugUserOps.innerHTML = '<div class="no-ops">none</div>';
  } else {
    $debugUserOps.innerHTML = userOps.map(renderOpEntry).join('');
  }

  // Copilot ops
  const copilotOps = engine.activeCopilotSession()?.diff() ?? [];
  if (copilotOps.length === 0) {
    $debugCopilotOps.innerHTML = '<div class="no-ops">none</div>';
  } else {
    $debugCopilotOps.innerHTML = copilotOps.map(renderOpEntry).join('');
  }
}

function renderOpEntry(op: Op | DiffEntry): string {
  const kindClass = op.kind;
  const prev = op.prev !== undefined ? esc(JSON.stringify(op.prev)) : '';
  const next = op.value !== undefined ? esc(JSON.stringify(op.value)) : '';
  const arrow = prev && next ? ' <span class="op-arrow">&rarr;</span> ' : '';

  return `
    <div class="op-entry">
      <span class="op-kind ${kindClass}">${op.kind}</span>
      <span class="op-path">${esc(op.path)}</span>
      ${prev ? `<span class="op-prev">${prev}</span>` : ''}
      ${arrow}
      ${next ? `<span class="op-next">${next}</span>` : ''}
    </div>
  `;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  const num = Number(raw);
  if (!isNaN(num) && raw !== '') return num;
  return raw;
}

// ─── Initial render ──────────────────────────────────────────────────────────

render();
