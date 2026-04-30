import { useState } from 'react';
import {
  useValue, useDiff, useExport, useEngineState,
  useCanUndo, useCanRedo, usePendingDiff, useFieldValidation,
} from '../src/react/index.js';
import { Engine } from '../src/engine.js';
import type { Op } from '../src/types.js';
import './style.css';

// ─── Config + Schema ─────────────────────────────────────────────────────────

const BASE = {
  appName: 'my-service',
  timeout: 30,
  retries: 3,
  server: { host: 'localhost', port: 8080 },
  features: { darkMode: true, analytics: false },
};

const SCHEMA = {
  type: 'object',
  required: ['appName', 'timeout', 'retries', 'server'],
  properties: {
    appName: { type: 'string', minLength: 1 },
    timeout: { type: 'integer', minimum: 0, maximum: 300 },
    retries: { type: 'integer', minimum: 0, maximum: 10 },
    server: {
      type: 'object',
      required: ['host', 'port'],
      properties: {
        host: { type: 'string', minLength: 1 },
        port: { type: 'integer', minimum: 1, maximum: 65535 },
      },
    },
    features: {
      type: 'object',
      properties: {
        darkMode:  { type: 'boolean' },
        analytics: { type: 'boolean' },
      },
    },
  },
};

// ─── App ─────────────────────────────────────────────────────────────────────
// Engine is created once. No subscription here — children subscribe to only
// what they need, so editing /server/port won't re-render /appName.

export function App() {
  const [engine] = useState(() => new Engine(BASE, SCHEMA));
  return (
    <div className="app">
      <header>
        <h1>patchwork</h1>
        <span className="subtitle">track changes · validate · undo</span>
      </header>
      <div className="layout">
        <div className="main-col">
          <EditorSection engine={engine} />
          <OpsPanel engine={engine} />
          <CopilotSection engine={engine} />
        </div>
        <div className="side-col">
          <BaseDoc engine={engine} />
          <CurrentDoc engine={engine} />
          <CodePanel />
        </div>
      </div>
    </div>
  );
}

// ─── EditorSection ────────────────────────────────────────────────────────────

function EditorSection({ engine }: { engine: Engine }) {
  const canUndo = useCanUndo(engine);
  const canRedo = useCanRedo(engine);

  return (
    <section className="card">
      <div className="card-header">
        <h2>Config Editor</h2>
        <div className="toolbar">
          <button disabled={!canUndo} onClick={() => engine.undo()}>Undo</button>
          <button disabled={!canRedo} onClick={() => engine.redo()}>Redo</button>
          <button className="btn-accent" onClick={() => { try { engine.apply(); } catch {} }}>
            Apply
          </button>
        </div>
      </div>

      <Field engine={engine} path="/appName" />
      <Field engine={engine} path="/timeout" />
      <Field engine={engine} path="/retries" />
      <div className="group-label">server</div>
      <Field engine={engine} path="/server/host" depth={1} />
      <Field engine={engine} path="/server/port" depth={1} />
      <div className="group-label">features</div>
      <Field engine={engine} path="/features/darkMode" depth={1} />
      <Field engine={engine} path="/features/analytics" depth={1} />

      <AddFieldForm engine={engine} />
    </section>
  );
}

// ─── Field ────────────────────────────────────────────────────────────────────
// Two hooks. Click any value to edit it in place.

function Field({ engine, path, depth = 0 }: { engine: Engine; path: string; depth?: number }) {
  const value = useValue(engine, path);
  const diff  = useDiff(engine, path);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState('');
  const key = path.split('/').pop()!;

  // Booleans use a checkbox — direct propose on change, no draft state needed.
  if (typeof value === 'boolean') {
    return (
      <div className={`field${diff ? ' changed' : ''}`} style={{ paddingLeft: depth * 20 }}>
        <span className="field-key">{key}</span>
        <span className="field-colon">:</span>
        <input
          type="checkbox"
          className="field-checkbox"
          checked={value}
          onChange={e => {
            try { engine.propose({ kind: 'replace', path, value: e.target.checked }); } catch {}
          }}
        />
        {diff && <DiffBadge diff={diff} />}
        {diff && <button className="btn-revert" onClick={() => engine.revert(path)}>↩</button>}
      </div>
    );
  }

  function startEdit() {
    setDraft(String(value));
    setEditing(true);
  }

  function commit(parsed: unknown) {
    try {
      engine.propose({ kind: 'replace', path, value: parsed });
      setEditing(false);
    } catch {}
  }

  return (
    <div className={`field${diff ? ' changed' : ''}`} style={{ paddingLeft: depth * 20 }}>
      <span className="field-key">{key}</span>
      <span className="field-colon">:</span>
      {editing ? (
        <FieldInput
          engine={engine}
          path={path}
          draft={draft}
          baseValue={engine.getBase(path)}
          onChange={setDraft}
          onCommit={commit}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <span
            className={`field-value type-${typeof value}`}
            onClick={startEdit}
            title="Click to edit"
          >
            {JSON.stringify(value)}
          </span>
          {diff && <DiffBadge diff={diff} />}
          {diff && <button className="btn-revert" onClick={() => engine.revert(path)}>↩</button>}
        </>
      )}
    </div>
  );
}

// ─── FieldInput ───────────────────────────────────────────────────────────────
// Separate component so useFieldValidation is called unconditionally
// (only mounts while parent Field is in edit mode).

function FieldInput({ engine, path, draft, baseValue, onChange, onCommit, onCancel }: {
  engine: Engine;
  path: string;
  draft: string;
  baseValue: unknown;
  onChange: (v: string) => void;
  onCommit: (parsed: unknown) => void;
  onCancel: () => void;
}) {
  const parsed = parseValue(draft, baseValue);
  const error  = useFieldValidation(engine, path, parsed);

  function tryCommit() {
    if (!error) onCommit(parsed);
  }

  return (
    <span className="field-edit">
      <input
        className={`field-input${error ? ' invalid' : ''}`}
        value={draft}
        autoFocus
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter')  tryCommit();
          if (e.key === 'Escape') onCancel();
        }}
      />
      <button className="btn-confirm" onClick={tryCommit} disabled={!!error}>✓</button>
      <button className="btn-cancel"  onClick={onCancel}>✕</button>
      {error && <span className="field-error">{error.errors[0]?.message}</span>}
    </span>
  );
}

// ─── DiffBadge ────────────────────────────────────────────────────────────────

function DiffBadge({ diff }: { diff: { base: unknown; current: unknown } }) {
  return (
    <span className="diff-badge">
      <span className="val-old">{JSON.stringify(diff.base)}</span>
      <span className="arrow">→</span>
      <span className="val-new">{JSON.stringify(diff.current)}</span>
    </span>
  );
}

// ─── AddFieldForm ─────────────────────────────────────────────────────────────
// Type a JSON Pointer path + raw JSON value to stage a new field.

function AddFieldForm({ engine }: { engine: Engine }) {
  const [addPath, setAddPath] = useState('');
  const [addRaw,  setAddRaw]  = useState('');
  const [formErr, setFormErr] = useState('');

  const validPath = addPath.startsWith('/') && addPath.length > 1;

  let parsedAdd: unknown;
  let jsonOk = false;
  try { if (addRaw.trim()) { parsedAdd = JSON.parse(addRaw); jsonOk = true; } } catch {}

  // Only run schema validation when we have a valid path and valid JSON — avoids
  // showing schema errors for undefined when the user is mid-typing a JSON value.
  const valError = useFieldValidation(
    engine,
    validPath ? addPath : '/appName',
    validPath && jsonOk ? parsedAdd : engine.getBase('/appName'),
  );

  function submit() {
    setFormErr('');
    if (!validPath) { setFormErr('Path must start with /'); return; }
    if (!jsonOk)    { setFormErr('Value must be valid JSON'); return; }
    try {
      const existing = (() => { try { return engine.get(addPath); } catch { return undefined; } })();
      engine.propose({ kind: existing === undefined ? 'add' : 'replace', path: addPath, value: parsedAdd });
      setAddPath('');
      setAddRaw('');
    } catch (e: unknown) {
      setFormErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="add-form">
      <input
        className="add-path"
        placeholder="/path/to/field"
        value={addPath}
        onChange={e => { setAddPath(e.target.value); setFormErr(''); }}
        onKeyDown={e => e.key === 'Enter' && submit()}
      />
      <input
        className="add-value"
        placeholder="value (JSON)"
        value={addRaw}
        onChange={e => { setAddRaw(e.target.value); setFormErr(''); }}
        onKeyDown={e => e.key === 'Enter' && submit()}
      />
      <button onClick={submit}>Add</button>
      {validPath && jsonOk && valError && (
        <span className="form-error">{valError.errors[0]?.message}</span>
      )}
      {validPath && addRaw.trim() && !jsonOk && (
        <span className="form-error">Value must be valid JSON</span>
      )}
      {formErr && <span className="form-error">{formErr}</span>}
    </div>
  );
}

// ─── OpsPanel ─────────────────────────────────────────────────────────────────
// Every pending change, in proposal order. Revert any op individually.

function OpsPanel({ engine }: { engine: Engine }) {
  const pending = usePendingDiff(engine);

  return (
    <section className="card">
      <h2>
        Pending Changes
        {pending.length > 0 && <span className="count">{pending.length}</span>}
      </h2>
      {pending.length === 0 ? (
        <div className="empty">No pending changes.</div>
      ) : (
        <div className="ops-list">
          {pending.map((op: Op) => (
            <div key={op.path} className="op-row">
              <span className={`op-kind ${op.kind}`}>{op.kind}</span>
              <span className="op-path">{op.path}</span>
              <span className="op-vals">
                {op.prev  !== undefined && <span className="val-old">{JSON.stringify(op.prev)}</span>}
                {op.prev  !== undefined && op.value !== undefined && <span className="arrow">→</span>}
                {op.value !== undefined && <span className="val-new">{JSON.stringify(op.value)}</span>}
              </span>
              <button
                className="btn-revert"
                onClick={() => { try { engine.revert(op.path); } catch {} }}
              >↩</button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ─── BaseDoc / CurrentDoc ─────────────────────────────────────────────────────

function BaseDoc({ engine }: { engine: Engine }) {
  useEngineState(engine); // re-render when apply() updates the base
  return (
    <section className="card">
      <h2>Base</h2>
      <pre className="code doc-scroll">{JSON.stringify(engine.getBase(''), null, 2)}</pre>
    </section>
  );
}

function CurrentDoc({ engine }: { engine: Engine }) {
  const doc = useExport(engine);
  return (
    <section className="card">
      <h2>Current</h2>
      <pre className="code doc-scroll">{JSON.stringify(doc, null, 2)}</pre>
    </section>
  );
}

// ─── CodePanel ────────────────────────────────────────────────────────────────

function CodePanel() {
  return (
    <>
      <section className="card">
        <h2>Editable Field</h2>
        <pre className="code">{`const value = useValue(engine, path)
const diff  = useDiff(engine, path)

// commit on Enter:
engine.propose({ kind: 'replace', path, value })
// per-field revert:
engine.revert(path)`}</pre>
      </section>

      <section className="card">
        <h2>Live Validation</h2>
        <pre className="code">{`const error = useFieldValidation(
  engine, path, draft
)
// null = valid — shown as you type`}</pre>
      </section>

      <section className="card">
        <h2>Ops + Undo</h2>
        <pre className="code">{`const pending = usePendingDiff(engine)
const canUndo = useCanUndo(engine)
const canRedo = useCanRedo(engine)

<button disabled={!canUndo}
  onClick={() => engine.undo()} />`}</pre>
      </section>

      <section className="card">
        <h2>What Patchwork Handles</h2>
        <div className="stat-grid">
          <StatRow label="Change tracking"     />
          <StatRow label="Schema validation"   />
          <StatRow label="Undo / redo"         />
          <StatRow label="Per-path reactivity" />
          <StatRow label="Diff (prev → current)" />
        </div>
      </section>
    </>
  );
}

function StatRow({ label }: { label: string }) {
  return (
    <div className="stat-row">
      <span className="stat-label">{label}</span>
      <span className="stat-val zero">0 lines</span>
    </div>
  );
}

// ─── CopilotSection (minimal) ─────────────────────────────────────────────────

function CopilotSection({ engine }: { engine: Engine }) {
  useEngineState(engine);
  const session = engine.activeCopilotSession();

  return (
    <section className="card">
      <div className="card-header">
        <h2>Copilot</h2>
        {!session && (
          <button onClick={() => simulateCopilot(engine)}>Simulate</button>
        )}
      </div>

      {!session ? (
        <div className="empty">
          Open a session to see AI proposals appear here for review.
        </div>
      ) : session.diff().length === 0 ? (
        <div className="empty">All proposals reviewed.</div>
      ) : (
        <>
          <div className="proposals">
            {session.diff().map(op => (
              <div key={op.path} className={`proposal${op.conflictsWithUser ? ' conflict' : ''}`}>
                <span className={`op-kind ${op.kind}`}>{op.kind}</span>
                <span className="op-path">{op.path}</span>
                <span className="op-vals">
                  {op.prev  !== undefined && <span className="val-old">{JSON.stringify(op.prev)}</span>}
                  {op.prev  !== undefined && op.value !== undefined && <span className="arrow">→</span>}
                  {op.value !== undefined && <span className="val-new">{JSON.stringify(op.value)}</span>}
                </span>
                {op.conflictsWithUser && <span className="conflict-tag">conflict</span>}
                <div className="proposal-btns">
                  <button className="btn-approve" onClick={() => session.approve(op.path)}>✓</button>
                  <button className="btn-decline" onClick={() => session.decline(op.path)}>✕</button>
                </div>
              </div>
            ))}
          </div>
          <div className="bulk-row">
            <button className="btn-approve" onClick={() => session.approveAll()}>Approve All</button>
            <button className="btn-decline" onClick={() => session.declineAll()}>Decline All</button>
          </div>
        </>
      )}
    </section>
  );
}

function simulateCopilot(engine: Engine) {
  const s = engine.startCopilot();
  s.propose([
    { kind: 'replace', path: '/timeout',            value: 60   },
    { kind: 'replace', path: '/server/port',         value: 443  },
    { kind: 'add',     path: '/server/ssl',          value: true },
    { kind: 'replace', path: '/features/analytics', value: true },
  ]);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseValue(raw: string, original: unknown): unknown {
  if (typeof original === 'number') {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  return raw;
}
