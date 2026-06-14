<template>
  <div class="playground-wrap">
    <div class="playground-header">
      <select @change="loadPreset(+($event.target as HTMLSelectElement).value)">
        <option v-for="(p, i) in presets" :key="i" :value="i">{{ p.label }}</option>
      </select>
      <span class="playground-status">{{ status }}</span>
      <span v-if="error" class="playground-error-inline">{{ error }}</span>
    </div>

    <div class="playground-body">
      <div class="playground-editor" ref="editorContainer" />

      <div class="playground-output" :class="{ empty: !hasResult }">
        <template v-if="hasResult">
          <div class="playground-pane">
            <div class="playground-pane-label">base</div>
            <pre>{{ baseStr }}</pre>
          </div>
          <div class="playground-pane">
            <div class="playground-pane-label">draft</div>
            <pre>{{ draftStr }}</pre>
          </div>
          <div class="playground-pane">
            <div class="playground-pane-label">diff</div>
            <pre>{{ diffStr }}</pre>
          </div>
        </template>
        <div v-else class="playground-empty">
          Edit the code and results appear automatically.
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { useData } from 'vitepress'
import { EditorView, basicSetup } from 'codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { oneDark } from '@codemirror/theme-one-dark'
import { Compartment } from '@codemirror/state'
import { Engine } from '../../../src/engine'

const { isDark } = useData()

interface Preset { label: string; code: string }

const presets: Preset[] = [
  {
    label: 'Basic editing',
    code: `const engine = new Engine({
  server: { host: 'localhost', port: 8080 },
  debug: false,
})

engine.replace('$.server.port', 443)
engine.add('$.server.ssl', true)
engine.delete('$.debug')

return engine`,
  },
  {
    label: 'Undo / redo',
    code: `const engine = new Engine({ count: 0 })

engine.replace('$.count', 1)
engine.replace('$.count', 2)
engine.replace('$.count', 3)

engine.undo()
engine.undo()
// count is back to 1

engine.redo()
// count is 2

return engine`,
  },
  {
    label: 'Accept / decline',
    code: `const engine = new Engine({ name: 'Alice', role: 'user' })

engine.replace('$.role', 'admin')
engine.accept()
// base and draft both show role: 'admin'

engine.replace('$.name', 'Bob')
engine.decline()
// draft reset to base — name stays Alice

return engine`,
  },
  {
    label: 'Keyed array diff',
    code: `const engine = new Engine(
  {
    users: [
      { id: 1, name: 'Alice', role: 'user' },
      { id: 2, name: 'Bob',   role: 'admin' },
      { id: 3, name: 'Carol', role: 'user' },
    ],
  },
  {
    schema: {
      type: 'object',
      properties: {
        users: {
          type: 'array',
          'x-key': 'id',
          items: { type: 'object' },
        },
      },
    },
  },
)

// Remove Bob — one op, no cascade
engine.delete('$.users[1]')

// Promote Alice — element-level replace with changes
engine.replace('$.users[0].role', 'admin')

return engine`,
  },
  {
    label: 'Ordered array + displacement',
    code: `const engine = new Engine(
  {
    steps: [
      { id: 'a', label: 'Fetch' },
      { id: 'b', label: 'Validate' },
      { id: 'c', label: 'Transform' },
      { id: 'd', label: 'Save' },
    ],
  },
  {
    schema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          'x-key': 'id',
          'x-ordered': true,
          items: { type: 'object' },
        },
      },
    },
  },
)

// Remove 'Validate' — c and d are displaced (move ops in diff)
engine.delete('$.steps[1]')

return engine`,
  },
  {
    label: 'Ephemeral session',
    code: `const engine = new Engine({ response: '' })

// All mutations collapse into one undo entry
engine.beginEphemeral()
engine.replace('$.response', 'Hello')
engine.replace('$.response', 'Hello, ')
engine.replace('$.response', 'Hello, world')
engine.replace('$.response', 'Hello, world!')
engine.commitEphemeral()

// One undo() snaps back to empty string
engine.undo()

return engine`,
  },
  {
    label: 'Scoped lens',
    code: `const engine = new Engine({
  cars:   [{ color: 'red',  make: 'Toyota' }],
  trucks: [{ color: 'blue', make: 'Ford'   }],
})

const cars = engine.getNodeEngine('$.cars')
cars.replace('$[0].color', 'yellow')

// Mutation is visible on both parent and lens.
// cars.diff() scopes ops to cars only.

return engine`,
  },
]

const editorContainer = ref<HTMLDivElement>()
const code = ref(presets[0].code)
const baseStr  = ref('')
const draftStr = ref('')
const diffStr  = ref('')
const error    = ref('')
const status   = ref('ready')
const hasResult = ref(false)

const themeCompartment = new Compartment()
let view: EditorView | null = null
let debounce: ReturnType<typeof setTimeout> | null = null

function run() {
  error.value = ''
  try {
    const fn = new Function('Engine', `"use strict";\n${code.value}`)
    const engine = fn(Engine) as Engine
    if (!engine || typeof engine.diff !== 'function') {
      error.value = 'Return an engine instance at the end of the code.'
      hasResult.value = false
      status.value = 'error'
      return
    }
    baseStr.value  = JSON.stringify(engine.base,  null, 2)
    draftStr.value = JSON.stringify(engine.draft, null, 2)
    diffStr.value  = JSON.stringify(engine.diff(), null, 2)
    hasResult.value = true
    status.value = 'ok'
  } catch (e: any) {
    error.value = e.message
    hasResult.value = false
    status.value = 'error'
  }
}

function schedule() {
  status.value = '...'
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(run, 500)
}

function loadPreset(index: number) {
  code.value = presets[index].code
  view?.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: presets[index].code },
  })
  run()
}

watch(isDark, (dark) => {
  view?.dispatch({
    effects: themeCompartment.reconfigure(dark ? oneDark : []),
  })
})

onMounted(() => {
  view = new EditorView({
    doc: code.value,
    extensions: [
      basicSetup,
      javascript(),
      themeCompartment.of(isDark.value ? oneDark : []),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          code.value = update.state.doc.toString()
          schedule()
        }
      }),
      EditorView.theme({
        '&': { height: '100%' },
        '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--vp-font-family-mono)', fontSize: '13px' },
      }),
    ],
    parent: editorContainer.value!,
  })
  run()
})

onBeforeUnmount(() => {
  view?.destroy()
  if (debounce) clearTimeout(debounce)
})
</script>
