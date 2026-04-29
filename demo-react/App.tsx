import { useState, useRef } from 'react';
import { useEngineState, useValue, useDiff } from '../src/react/index.js';
import { Engine } from '../src/engine.js';
import type { CopilotSession } from '../src/copilot.js';
import type { DiffEntry } from '../src/types.js';
import './style.css';

const INITIAL_CONFIG = {
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
        darkMode: { type: 'boolean' },
        analytics: { type: 'boolean' },
      },
    },
  },
};

// ── App ───────────────────────────────────────────────────────────────────────
// App creates the engine but does NOT subscribe — each child subscribes only
// to what it needs, giving true per-path reactivity.

export function App() {
  const [engine] = useState(() => new Engine(INITIAL_CONFIG, SCHEMA));

  return (
    <div className="app">
      <header>
        <h1>patchwork</h1>
        <span className="subtitle">copilot-native JSON editing engine</span>
      </header>
      <div className="layout">
        <div className="main-col">
          <DocumentSection engine={engine} />
          <ActionsSection engine={engine} />
          <CopilotSection engine={engine} />
        </div>
        <div className="side-col">
          <CodePanel />
        </div>
      </div>
    </div>
  );
}

// ── Document ──────────────────────────────────────────────────────────────────

function DocumentSection({ engine }: { engine: Engine }) {
  return (
    <section className="card">
      <div className="card-header">
        <h2>Document</h2>
        <div className="toolbar">
          <button onClick={() => engine.undo()}>Undo</button>
          <button onClick={() => engine.redo()}>Redo</button>
          <button className="btn-accent" onClick={() => engine.apply()}>Apply</button>
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
    </section>
  );
}

// ── Field — the key primitive ─────────────────────────────────────────────────
// Two hooks. Everything else is JSX.

function Field({ engine, path, depth = 0 }: { engine: Engine; path: string; depth?: number }) {
  const value = useValue(engine, path);
  const diff  = useDiff(engine, path);
  const renders = useRef(0);
  renders.current++;

  return (
    <div className={`field${diff ? ' changed' : ''}`} style={{ paddingLeft: depth * 20 }}>
      <span className="render-badge" title="React renders">{renders.current}</span>
      <span className="field-key">{path.split('/').pop()}</span>
      <span className="field-colon">:</span>
      <span className={`field-value type-${valueType(value)}`}>{JSON.stringify(value)}</span>
      {diff && (
        <span className="diff-badge">
          <span className="val-old">{JSON.stringify(diff.base)}</span>
          <span className="arrow">&rarr;</span>
          <span className="val-new">{JSON.stringify(diff.current)}</span>
        </span>
      )}
    </div>
  );
}

// ── Actions ───────────────────────────────────────────────────────────────────

function ActionsSection({ engine }: { engine: Engine }) {
  const actions: Array<{ label: string; op: Parameters<Engine['propose']>[0] }> = [
    { label: '/server/port → 443',          op: { kind: 'replace', path: '/server/port', value: 443 } },
    { label: '/server/host → 0.0.0.0',      op: { kind: 'replace', path: '/server/host', value: '0.0.0.0' } },
    { label: '/timeout → 60',               op: { kind: 'replace', path: '/timeout', value: 60 } },
    { label: '/features/analytics → true',  op: { kind: 'replace', path: '/features/analytics', value: true } },
    { label: '/server/ssl → true (add)',     op: { kind: 'add',     path: '/server/ssl', value: true } },
    { label: '/retries (remove)',            op: { kind: 'remove',  path: '/retries' } },
  ];

  return (
    <section className="card">
      <h2>User Actions</h2>
      <div className="ops-list">
        {actions.map(({ label, op }) => (
          <div key={label} className="op-entry" style={{ justifyContent: 'space-between' }}>
            <span className={`op-kind ${op.kind}`}>{op.kind}</span>
            <span className="op-path" style={{ flex: 1, marginLeft: 6 }}>{label}</span>
            <button onClick={() => { try { engine.propose(op); } catch {} }}>Run</button>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Copilot ───────────────────────────────────────────────────────────────────

function CopilotSection({ engine }: { engine: Engine }) {
  useEngineState(engine); // subscribe to session start/end
  const session = engine.activeCopilotSession();

  return (
    <section className="card">
      <div className="card-header">
        <h2>Copilot Session</h2>
        {!session && (
          <button className="btn-accent" onClick={() => simulateCopilot(engine)}>
            Simulate Copilot
          </button>
        )}
      </div>
      {!session ? (
        <div className="empty">No active session. Click "Simulate Copilot" to see the propose / approve / decline workflow.</div>
      ) : (
        <CopilotProposals session={session} />
      )}
    </section>
  );
}

function simulateCopilot(engine: Engine) {
  const session = engine.startCopilot();
  session.propose([
    { kind: 'replace', path: '/timeout',              value: 60 },
    { kind: 'replace', path: '/server/port',          value: 443 },
    { kind: 'add',     path: '/server/ssl',           value: true },
    { kind: 'replace', path: '/features/analytics',   value: true },
  ]);
}

function CopilotProposals({ session }: { session: CopilotSession }) {
  const proposals = session.diff();
  if (proposals.length === 0) return <div className="empty">All proposals reviewed.</div>;

  return (
    <div>
      <div className="proposals">
        {proposals.map((op: DiffEntry) => (
          <div key={op.path} className={`proposal${op.conflictsWithUser ? ' conflict' : ''}`}>
            <span className={`op-kind ${op.kind}`}>{op.kind}</span>
            <span className="op-path">{op.path}</span>
            <span className="op-values">
              {op.prev !== undefined && <span className="val-old">{JSON.stringify(op.prev)}</span>}
              {op.prev !== undefined && op.value !== undefined && <span className="arrow">&rarr;</span>}
              {op.value !== undefined && <span className="val-new">{JSON.stringify(op.value)}</span>}
            </span>
            {op.conflictsWithUser && <span className="conflict-badge">conflict</span>}
            <div className="proposal-actions">
              <button className="btn-approve" onClick={() => session.approve(op.path)}>Approve</button>
              <button className="btn-decline" onClick={() => session.decline(op.path)}>Decline</button>
            </div>
          </div>
        ))}
      </div>
      <div className="bulk-actions">
        <button className="btn-approve" onClick={() => session.approveAll()}>Approve All</button>
        <button className="btn-decline" onClick={() => session.declineAll()}>Decline All</button>
        <button onClick={() => session.end()}>End Session</button>
      </div>
    </div>
  );
}

// ── Code Panel ────────────────────────────────────────────────────────────────

function CodePanel() {
  return (
    <>
      <section className="card">
        <h2>Read State</h2>
        <pre className="code">{
`const value = useValue(engine, path)
const diff  = useDiff(engine, path)
// diff → { base, current } | null`
        }</pre>
        <p className="code-note">
          Edit a single field — only that field's badge increments.
          Each <code>Field</code> subscribes independently.
        </p>
      </section>

      <section className="card">
        <h2>Make Changes</h2>
        <pre className="code">{
`engine.propose({ kind: 'replace',
  path: '/server/port', value: 443 })

engine.undo()   // full history — zero impl
engine.redo()
engine.apply()  // fold edits into base`
        }</pre>
      </section>

      <section className="card">
        <h2>Copilot Workflow</h2>
        <pre className="code">{
`const session = engine.startCopilot()
session.propose([
  { kind: 'replace', path: '/server/port',
    value: 443 },
])

session.approve('/server/port') // → undo stack
session.decline('/server/ssl')  // dropped
session.approveAll()`
        }</pre>
      </section>

      <section className="card">
        <h2>What You Wrote</h2>
        <div className="stat-grid">
          <StatRow label="Field (value + diff + badge)" value="14 lines" />
          <StatRow label="Copilot UI"                   value="22 lines" />
          <StatRow label="Actions + layout"             value="~30 lines" />
          <StatRow label="Total"                        value="~66 lines" bold />
        </div>

        <div className="stat-divider" />

        <h2>What Patchwork Handles</h2>
        <div className="stat-grid">
          <StatRow label="State management"   value="0 lines" zero />
          <StatRow label="Undo / redo"        value="0 lines" zero />
          <StatRow label="Diff tracking"      value="0 lines" zero />
          <StatRow label="Per-path reactivity" value="0 lines" zero />
          <StatRow label="Conflict detection" value="0 lines" zero />
          <StatRow label="Schema validation"  value="0 lines" zero />
        </div>
      </section>
    </>
  );
}

function StatRow({ label, value, bold, zero }: { label: string; value: string; bold?: boolean; zero?: boolean }) {
  return (
    <div className={`stat-row${bold ? ' stat-bold' : ''}`}>
      <span className="stat-label">{label}</span>
      <span className={`stat-val${zero ? ' stat-zero' : ''}`}>{value}</span>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function valueType(v: unknown): string {
  if (v === null) return 'null';
  return typeof v;
}
