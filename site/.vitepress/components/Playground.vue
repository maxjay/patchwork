<template>
  <div class="playground-wrap">
    <div class="playground-header">
      <select :value="currentPreset" @change="loadPreset(+($event.target as HTMLSelectElement).value)">
        <option v-for="(p, i) in presets" :key="i" :value="i">{{ p.label }}</option>
      </select>
      <button @click="run">Run</button>
      <span v-if="error" style="color: var(--vp-c-danger-1); font-size: 13px;">{{ error }}</span>
    </div>
    <div class="playground-body">
      <div class="playground-editor">
        <textarea
          v-model="code"
          spellcheck="false"
          @keydown.tab.prevent="onTab"
        />
      </div>
      <div class="playground-output">
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
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { Engine } from '../../../src/engine'

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
// base and draft both have role: 'admin'

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

// Remove Bob — one remove op, no cascade
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

// Remove 'Validate' — c and d are displaced (move ops)
engine.delete('$.steps[1]')

return engine`,
  },
  {
    label: 'Ephemeral session',
    code: `const engine = new Engine({ response: '' })

// All replacements collapse into one undo entry
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

// mutation is visible on both parent and lens
// cars.draft[0].color === 'yellow'
// engine.draft.cars[0].color === 'yellow'

return engine`,
  },
]

const currentPreset = ref(0)
const code = ref(presets[0].code)
const baseStr = ref('')
const draftStr = ref('')
const diffStr = ref('')
const error = ref('')

function run() {
  error.value = ''
  try {
    const fn = new Function('Engine', `"use strict";\n${code.value}`)
    const engine = fn(Engine) as Engine
    if (!engine || typeof engine.diff !== 'function') {
      error.value = 'Code must return an engine instance'
      return
    }
    baseStr.value  = JSON.stringify(engine.base, null, 2)
    draftStr.value = JSON.stringify(engine.draft, null, 2)
    diffStr.value  = JSON.stringify(engine.diff(), null, 2)
  } catch (e: any) {
    error.value = e.message
    baseStr.value = draftStr.value = diffStr.value = ''
  }
}

function loadPreset(index: number) {
  currentPreset.value = index
  code.value = presets[index].code
  run()
}

function onTab(e: KeyboardEvent) {
  const el = e.target as HTMLTextAreaElement
  const start = el.selectionStart
  const end = el.selectionEnd
  el.value = el.value.slice(0, start) + '  ' + el.value.slice(end)
  el.selectionStart = el.selectionEnd = start + 2
  code.value = el.value
}

onMounted(run)
</script>
