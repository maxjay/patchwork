import { useRef } from 'react';
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

// ─── App ─────────────────────────────────────────────────────────────────────

export function App() {
  const engine = useEngine(INITIAL_CONFIG, SCHEMA);

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
              <h2>Document</h2>
              <div className="toolbar">
                <button onClick={() => engine.undo()}>Undo</button>
                <button onClick={() => engine.redo()}>Redo</button>
                <button className="btn-accent" onClick={() => engine.apply()}>Apply</button>
              </div>
            </div>
            <Node engine={engine} path="" depth={0} />
          </section>

          <section className="card">
            <h2>User Actions</h2>
            <div className="ops-list">
              <ActionButton engine={engine} label="set /server/port → 443" op={{ kind: 'replace', path: '/server/port', value: 443 }} />
              <ActionButton engine={engine} label="set /server/host → 0.0.0.0" op={{ kind: 'replace', path: '/server/host', value: '0.0.0.0' }} />
              <ActionButton engine={engine} label="set /timeout → 60" op={{ kind: 'replace', path: '/timeout', value: 60 }} />
              <ActionButton engine={engine} label="toggle /features/darkMode" op={{ kind: 'replace', path: '/features/darkMode', value: !INITIAL_CONFIG.features.darkMode }} />
              <ActionButton engine={engine} label="add /server/ssl → true" op={{ kind: 'add', path: '/server/ssl', value: true }} />
              <ActionButton engine={engine} label="remove /retries" op={{ kind: 'remove', path: '/retries' }} />
            </div>
            <div className="empty" style={{ marginTop: 8 }}>
              Invalid ops are rejected by the schema — try undo after any action.
            </div>
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

// ─── Node — reactive, read-only display ──────────────────────────────────────

function Node({ engine, path, depth }: { engine: Engine; path: string; depth: number }) {
  const node = useNode(engine, path);
  const renderCount = useRef(0);
  renderCount.current++;

  if (!node) return null;

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

  return <Leaf node={node} depth={depth} renderCount={renderCount.current} />;
}

function Leaf({ node, depth, renderCount }: { node: NodeInfo; depth: number; renderCount: number }) {
  return (
    <div className={`field${node.changed ? ' changed' : ''}`} style={{ paddingLeft: depth * 20 }}>
      <span className="render-badge" title="React render count">{renderCount}</span>
      <span className="field-key">{node.key}</span>
      <span className="field-colon">:</span>
      <span className={`field-value type-${node.type}`}>{JSON.stringify(node.value)}</span>
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

// ─── Action Button ────────────────────────────────────────────────────────────

function ActionButton({ engine, label, op }: { engine: Engine; label: string; op: Parameters<Engine['propose']>[0] }) {
  const handleClick = () => {
    try { engine.propose(op); } catch { /* schema rejected */ }
  };
  return (
    <div className="op-entry" style={{ justifyContent: 'space-between' }}>
      <span className={`op-kind ${op.kind}`}>{op.kind}</span>
      <span className="op-path" style={{ flex: 1, marginLeft: 6 }}>{label.replace(/^(add|replace|remove|toggle) /, '')}</span>
      <button onClick={handleClick}>Run</button>
    </div>
  );
}

// ─── Copilot Section ──────────────────────────────────────────────────────────

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
        <CopilotProposals session={session} />
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

function CopilotProposals({ session }: { session: CopilotSession }) {
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

// ─── Live Document ────────────────────────────────────────────────────────────

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

// ─── Diff Panel ───────────────────────────────────────────────────────────────

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

// ─── Render Tracker ───────────────────────────────────────────────────────────

function RenderTracker() {
  return (
    <section className="card">
      <h2>Per-Path Reactivity</h2>
      <div className="empty" style={{ lineHeight: 1.6 }}>
        Each node shows a <span className="render-badge inline">n</span> badge counting
        its React renders. Run an action and watch — only the affected path's
        counter increments. Object nodes only re-render when keys are
        added or removed. All powered by one hook: <code>useNode</code>.
      </div>
    </section>
  );
}
