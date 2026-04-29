import { useRef, useState, useCallback } from 'react';
import { useEngine, useNode, useExport } from '../src/react/index.js';
import type { Engine } from '../src/engine.js';
import type { NodeInfo } from '../src/types.js';
import type { CopilotSession } from '../src/copilot.js';
import type { DiffEntry } from '../src/types.js';
import './style.css';

const INITIAL_CONFIG = {
  appName: 'my-service',
  timeout: 30,
  retries: 3,
  server: {
    host: 'localhost',
    port: 8080,
  },
  features: {
    darkMode: true,
    analytics: false,
  },
};

// ─── App ────────────────────────────────────────────────────────────────────

export function App() {
  const engine = useEngine(INITIAL_CONFIG);

  return (
    <div className="app">
      <header>
        <h1>patchwork</h1>
        <span className="subtitle">copilot-native JSON editing engine</span>
      </header>

      <div className="layout">
        <div className="main-col">
          <section className="card">
            <div className="card-header">
              <h2>Editor</h2>
              <div className="toolbar">
                <button onClick={() => engine.undo()}>Undo</button>
                <button onClick={() => engine.redo()}>Redo</button>
                <button className="btn-accent" onClick={() => engine.apply()}>Apply</button>
              </div>
            </div>

            <Node engine={engine} path="" depth={0} />

            <AddField engine={engine} />
            <MoveField engine={engine} />
          </section>
          <CopilotSection engine={engine} />
        </div>
        <div className="side-col">
          <LiveDocument engine={engine} />
          <DiffPanel engine={engine} />
          <RenderTracker />
        </div>
      </div>
    </div>
  );
}

// ─── Node (one component, one hook) ─────────────────────────────────────────

function Node({
  engine,
  path,
  depth,
}: {
  engine: Engine;
  path: string;
  depth: number;
}) {
  const node = useNode(engine, path);
  const renderCount = useRef(0);
  renderCount.current++;

  if (!node) return null;

  // Container — render children
  if (node.keys) {
    return (
      <div className="node-object">
        {node.key && (
          <div className="group-label" style={{ paddingLeft: (depth - 1) * 20 }}>
            <span className="render-badge" title="React render count">{renderCount.current}</span>
            {node.key}
          </div>
        )}
        {node.keys.map((k) => (
          <Node key={k} engine={engine} path={`${path}/${k}`} depth={depth + 1} />
        ))}
      </div>
    );
  }

  // Leaf — render editable field
  return <LeafField engine={engine} node={node} depth={depth} renderCount={renderCount.current} />;
}

function LeafField({
  engine,
  node,
  depth,
  renderCount,
}: {
  engine: Engine;
  node: NodeInfo;
  depth: number;
  renderCount: number;
}) {
  const handleCommit = useCallback((e: React.FocusEvent<HTMLInputElement> | React.KeyboardEvent<HTMLInputElement>) => {
    const input = e.target as HTMLInputElement;
    const raw = input.value.trim();
    const parsed = parseValue(raw);
    if (parsed !== node.value) {
      engine.propose({ kind: 'replace', path: node.path, value: parsed });
    }
  }, [engine, node.path, node.value]);

  return (
    <div className={`field${node.changed ? ' changed' : ''}`} style={{ paddingLeft: depth * 20 }}>
      <span className="render-badge" title="React render count">{renderCount}</span>
      <span className="field-key">{node.key}</span>
      <span className="field-colon">:</span>
      <input
        className={`field-input type-${node.type}`}
        defaultValue={String(node.value)}
        key={`${node.path}:${String(node.value)}`}
        onBlur={handleCommit}
        onKeyDown={(e) => { if (e.key === 'Enter') handleCommit(e); }}
      />
      {node.changed && (
        <button className="btn-reset" onClick={() => engine.reset(node.path)} title="Reset to base">
          &#8617;
        </button>
      )}
      <button className="btn-remove" onClick={() => engine.propose({ kind: 'remove', path: node.path })} title="Remove field">
        &times;
      </button>
      {node.changed && (
        <span className="diff-badge">
          <span className="val-old">{JSON.stringify(node.base)}</span>
          <span className="arrow">&rarr;</span>
          <span className="val-new">{JSON.stringify(node.value)}</span>
        </span>
      )}
    </div>
  );
}

// ─── Add Field ──────────────────────────────────────────────────────────────

function AddField({ engine }: { engine: Engine }) {
  const [path, setPath] = useState('');
  const [value, setValue] = useState('');

  const submit = () => {
    if (!path) return;
    const resolved = path.startsWith('/') ? path : `/${path}`;
    engine.propose({ kind: 'add', path: resolved, value: parseValue(value) });
    setPath('');
    setValue('');
  };

  return (
    <div className="add-row">
      <input placeholder="path (e.g. /server/maxConn)" value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
      <input placeholder="value" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
      <button onClick={submit}>+ Add</button>
    </div>
  );
}

// ─── Move / Rename Field ────────────────────────────────────────────────────

function MoveField({ engine }: { engine: Engine }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const submit = () => {
    if (!from || !to) return;
    try {
      engine.move(from, to);
      setFrom('');
      setTo('');
    } catch {
      // path not found
    }
  };

  return (
    <div className="add-row">
      <input placeholder="from (e.g. /retries)" value={from} onChange={(e) => setFrom(e.target.value)} />
      <input placeholder="to (e.g. /maxRetries)" value={to} onChange={(e) => setTo(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
      <button onClick={submit}>Move</button>
    </div>
  );
}

// ─── Copilot Section ────────────────────────────────────────────────────────

function CopilotSection({ engine }: { engine: Engine }) {
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
        <div className="empty">No active copilot session. Click "Simulate Copilot" to see the approve/decline workflow.</div>
      ) : (
        <CopilotProposals engine={engine} session={session} />
      )}
    </section>
  );
}

function simulateCopilot(engine: Engine) {
  const session = engine.startCopilot();
  session.propose([
    { kind: 'replace', path: '/timeout', value: 60 },
    { kind: 'replace', path: '/server/port', value: 443 },
    { kind: 'add', path: '/server/ssl', value: true },
    { kind: 'replace', path: '/features/analytics', value: true },
  ]);
}

function CopilotProposals({ engine, session }: { engine: Engine; session: CopilotSession }) {
  const proposals = session.diff();

  if (proposals.length === 0) {
    return <div className="empty">All proposals reviewed.</div>;
  }

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

// ─── Live Document ──────────────────────────────────────────────────────────

function LiveDocument({ engine }: { engine: Engine }) {
  const doc = useExport(engine);

  return (
    <section className="card">
      <h2>Live Document</h2>
      <pre className="json">{JSON.stringify(doc, null, 2)}</pre>
      <div className="meta">version {engine.version}</div>
    </section>
  );
}

// ─── Diff Panel ─────────────────────────────────────────────────────────────

function DiffPanel({ engine }: { engine: Engine }) {
  const ops = engine.diff();

  return (
    <section className="card">
      <h2>User Ops ({ops.length})</h2>
      {ops.length === 0 ? (
        <div className="empty">No pending changes</div>
      ) : (
        <div className="ops-list">
          {ops.map((op) => (
            <div key={op.path} className="op-entry">
              <span className={`op-kind ${op.kind}`}>{op.kind}</span>
              <span className="op-path">{op.path}</span>
              {op.prev !== undefined && <span className="val-old">{JSON.stringify(op.prev)}</span>}
              {op.prev !== undefined && op.value !== undefined && <span className="arrow">&rarr;</span>}
              {op.value !== undefined && <span className="val-new">{JSON.stringify(op.value)}</span>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Render Tracker ─────────────────────────────────────────────────────────

function RenderTracker() {
  return (
    <section className="card">
      <h2>Per-Path Reactivity</h2>
      <div className="empty" style={{ lineHeight: 1.6 }}>
        Each node shows a <span className="render-badge inline">n</span> badge counting
        its React renders. Edit a single field and watch — only that field's
        counter increments. Object nodes only re-render when keys are
        added or removed. All powered by one hook: <code>useNode</code>.
      </div>
    </section>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  const num = Number(raw);
  if (!isNaN(num) && raw !== '') return num;
  return raw;
}
