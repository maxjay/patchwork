import { Engine } from '../src/index.js';
import type { Op, DiffEntry } from '../src/index.js';
import { createEditTools } from '../src/tools/index.js';
import type { EditTool } from '../src/tools/index.js';

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

// ─── DOM refs ────────────────────────────────────────────────────────────────

const $editor = document.getElementById('editor')!;
const $undoBtn = document.getElementById('undo-btn')!;
const $redoBtn = document.getElementById('redo-btn')!;
const $addKey = document.getElementById('add-key') as HTMLInputElement;
const $addValue = document.getElementById('add-value') as HTMLInputElement;
const $addSubmit = document.getElementById('add-submit')!;
const $copilotProposals = document.getElementById('copilot-proposals')!;
const $copilotBulk = document.getElementById('copilot-bulk')!;
const $approveAll = document.getElementById('approve-all')!;
const $declineAll = document.getElementById('decline-all')!;
const $endSession = document.getElementById('end-session')!;
const $provider = document.getElementById('provider') as HTMLSelectElement;
const $endpoint = document.getElementById('endpoint') as HTMLInputElement;
const $modelName = document.getElementById('model-name') as HTMLInputElement;
const $apiKey = document.getElementById('api-key') as HTMLInputElement;
const $chatMessages = document.getElementById('chat-messages')!;
const $chatInput = document.getElementById('chat-input') as HTMLInputElement;
const $chatSend = document.getElementById('chat-send')!;
const $debugBase = document.getElementById('debug-base')!;
const $debugUserOps = document.getElementById('debug-user-ops')!;
const $debugCopilotOps = document.getElementById('debug-copilot-ops')!;
const $debugCurrent = document.getElementById('debug-current')!;
const $debugVersion = document.getElementById('debug-version')!;

// ─── Auto-render on any engine change ────────────────────────────────────────

engine.onChange(render);

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
  renderObject(current, '', 0, changedPaths, copilotPaths);
}

function renderObject(
  obj: Record<string, unknown>,
  prefix: string,
  depth: number,
  changedPaths: Set<string>,
  copilotPaths: Set<string>,
) {
  for (const [key, value] of Object.entries(obj)) {
    const path = `${prefix}/${key}`;

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const section = document.createElement('div');
      section.className = 'field-section';
      section.innerHTML = `${'&nbsp;'.repeat(depth * 4)}<span class="field-key">${esc(key)}</span><span class="field-colon">:</span>`;
      $editor.appendChild(section);
      renderObject(value as Record<string, unknown>, path, depth + 1, changedPaths, copilotPaths);
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

      // Tooltip for changed fields — use getDiff to compare against base
      const diff = engine.getDiff(path);
      if (diff) {
        const tip = document.createElement('div');
        tip.className = 'tooltip';
        const baseStr = diff.base !== undefined ? esc(JSON.stringify(diff.base)) : '<i>none</i>';
        const currStr = diff.current !== undefined ? esc(JSON.stringify(diff.current)) : '<i>none</i>';
        tip.innerHTML = `<span class="base-val">${baseStr}</span> &rarr; <span class="curr-val">${currStr}</span>`;
        row.appendChild(tip);
      }

      $editor.appendChild(row);
    }
  }
}

// ─── Editor events ───────────────────────────────────────────────────────────

$editor.addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  if (!input.dataset.path) return;
  engine.propose({ kind: 'replace', path: input.dataset.path, value: parseValue(input.value.trim()) });
});

$editor.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('.field-remove') as HTMLElement | null;
  if (!btn?.dataset.path) return;
  engine.propose({ kind: 'remove', path: btn.dataset.path });
});

$undoBtn.addEventListener('click', () => engine.undo());
$redoBtn.addEventListener('click', () => engine.redo());

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
    e.preventDefault();
    engine.undo();
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && e.shiftKey) {
    e.preventDefault();
    engine.redo();
  }
});

function submitAddField() {
  const key = $addKey.value.trim();
  const rawValue = $addValue.value.trim();
  if (!key) return;

  const path = key.startsWith('/') ? key : `/${key}`;
  engine.propose({ kind: 'add', path, value: parseValue(rawValue) });
  $addKey.value = '';
  $addValue.value = '';
  $addKey.focus();
}

$addSubmit.addEventListener('click', submitAddField);
$addValue.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAddField(); });
$addKey.addEventListener('keydown', (e) => { if (e.key === 'Enter') $addValue.focus(); });

// ─── Copilot proposals UI ────────────────────────────────────────────────────

$approveAll.addEventListener('click', () => engine.activeCopilotSession()?.approveAll());
$declineAll.addEventListener('click', () => engine.activeCopilotSession()?.declineAll());
$endSession.addEventListener('click', () => engine.activeCopilotSession()?.end());

$copilotProposals.addEventListener('click', (e) => {
  const btn = e.target as HTMLElement;
  const path = btn.dataset.path;
  if (!path) return;

  const session = engine.activeCopilotSession();
  if (!session) return;

  if (btn.classList.contains('btn-approve')) session.approve(path);
  else if (btn.classList.contains('btn-decline')) session.decline(path);
});

function renderCopilot() {
  const session = engine.activeCopilotSession();

  if (!session) {
    $copilotProposals.innerHTML = '<div class="no-ops">No active session</div>';
    $copilotBulk.classList.add('hidden');
    return;
  }

  const ops = session.diff();
  if (ops.length === 0) {
    $copilotProposals.innerHTML = '<div class="no-ops">No pending proposals</div>';
    $copilotBulk.classList.remove('hidden');
    return;
  }

  $copilotBulk.classList.remove('hidden');
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

// ─── Chat with Claude ────────────────────────────────────────────────────────

const tools = createEditTools(engine);

// Convert our EditTool[] to Anthropic API tool format
function toAnthropicTools(editTools: EditTool[]) {
  return editTools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

const SYSTEM_PROMPT =
  'You are a config editing copilot. The user has a JSON config document open in an editor. ' +
  'You can read and modify it using the provided tools.\n\n' +
  'Workflow:\n' +
  '1. Call start_session to begin a copilot editing session\n' +
  '2. Use get_value to read the current config (path "" for root)\n' +
  '3. Use propose to suggest changes — each proposal is held for user review\n' +
  '4. Use move to rename or relocate fields\n' +
  '5. The user will approve or decline each proposal in the UI\n\n' +
  'Keep responses short. Propose changes, then briefly explain what you did.';

type ChatMessage = {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
};

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

let chatHistory: ChatMessage[] = [];
let chatBusy = false;

$apiKey.addEventListener('input', () => {
  const hasKey = $apiKey.value.trim().length > 0;
  ($chatInput as HTMLInputElement).disabled = !hasKey;
  ($chatSend as HTMLButtonElement).disabled = !hasKey;
});

$chatSend.addEventListener('click', sendChat);
$chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});

function appendChatBubble(cls: string, text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = `chat-msg ${cls}`;
  el.textContent = text;
  $chatMessages.appendChild(el);
  $chatMessages.scrollTop = $chatMessages.scrollHeight;
  return el;
}

async function sendChat() {
  if (chatBusy) return;
  const text = $chatInput.value.trim();
  if (!text) return;
  const apiKey = $apiKey.value.trim();
  if (!apiKey) return;

  $chatInput.value = '';
  appendChatBubble('user', text);
  chatHistory.push({ role: 'user', content: text });

  chatBusy = true;
  $chatInput.disabled = true;

  try {
    await runAgentLoop(apiKey);
  } catch (err) {
    appendChatBubble('error', `Error: ${(err as Error).message}`);
  } finally {
    chatBusy = false;
    $chatInput.disabled = false;
    $chatInput.focus();
  }
}

async function runAgentLoop(apiKey: string) {
  let thinkingEl = appendChatBubble('thinking', 'Thinking...');

  while (true) {
    const response = await callClaude(apiKey, chatHistory);

    // Remove thinking indicator
    thinkingEl.remove();

    // Check for tool use
    const toolUseBlocks = response.content.filter(
      (b: ContentBlock) => b.type === 'tool_use',
    ) as { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }[];

    const textBlocks = response.content.filter(
      (b: ContentBlock) => b.type === 'text',
    ) as { type: 'text'; text: string }[];

    // Show any text
    for (const tb of textBlocks) {
      if (tb.text.trim()) appendChatBubble('assistant', tb.text);
    }

    // If no tool use, we're done
    if (toolUseBlocks.length === 0) {
      chatHistory.push({ role: 'assistant', content: response.content });
      break;
    }

    // Show tool calls and execute them
    chatHistory.push({ role: 'assistant', content: response.content });

    const toolResults: ContentBlock[] = [];
    for (const block of toolUseBlocks) {
      const inputStr = Object.keys(block.input).length > 0
        ? ` ${JSON.stringify(block.input)}`
        : '';
      appendChatBubble('tool-use', `${block.name}${inputStr}`);

      const tool = tools.find((t) => t.name === block.name);
      if (!tool) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: `Unknown tool: ${block.name}`,
          is_error: true,
        });
        continue;
      }

      const result = tool.handler(block.input);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result.content,
        is_error: result.isError,
      });
    }

    chatHistory.push({ role: 'user', content: toolResults });

    // Continue the loop for the next response
    thinkingEl = appendChatBubble('thinking', 'Thinking...');
  }
}

async function callClaude(
  apiKey: string,
  messages: ChatMessage[],
): Promise<{ content: ContentBlock[] }> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: toAnthropicTools(tools),
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }

  return res.json();
}

// ─── Debug ───────────────────────────────────────────────────────────────────

function renderDebug() {
  $debugBase.textContent = JSON.stringify(engine.getBase(''), null, 2);
  $debugCurrent.textContent = JSON.stringify(engine.export(), null, 2);
  $debugVersion.textContent = `version: ${engine.version}`;

  const userOps = engine.diff();
  $debugUserOps.innerHTML = userOps.length === 0
    ? '<div class="no-ops">none</div>'
    : userOps.map(renderOpEntry).join('');

  const copilotOps = engine.activeCopilotSession()?.diff() ?? [];
  $debugCopilotOps.innerHTML = copilotOps.length === 0
    ? '<div class="no-ops">none</div>'
    : copilotOps.map(renderOpEntry).join('');
}

function renderOpEntry(op: Op | DiffEntry): string {
  const prev = op.prev !== undefined ? esc(JSON.stringify(op.prev)) : '';
  const next = op.value !== undefined ? esc(JSON.stringify(op.value)) : '';
  const arrow = prev && next ? ' <span class="op-arrow">&rarr;</span> ' : '';

  return `
    <div class="op-entry">
      <span class="op-kind ${op.kind}">${op.kind}</span>
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
