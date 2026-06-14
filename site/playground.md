---
title: Playground
---

# Playground

Select a preset or write your own code. The code runs in the browser against the live engine. Return an `Engine` instance to see its state.

<Playground />

## Writing your own

The editor runs in a function scope with `Engine` in scope. Return the engine to see its `base`, `draft`, and `diff`.

```js
const engine = new Engine({ /* your document */ }, { schema: { /* optional */ } })

// ... mutations

return engine
```

Anything valid in the [guide](/) or [array diffing](/arrays) docs works here.
