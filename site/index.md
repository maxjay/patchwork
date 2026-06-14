---
layout: home

hero:
  name: patchwork
  text: JSON editing with a memory.
  tagline: Wrap any JSON document in an Engine. Get base/draft, diff, undo, and scoped lenses in one primitive.
  actions:
    - theme: brand
      text: Get started
      link: /guide
    - theme: alt
      text: Playground
      link: /playground

features:
  - title: Base / draft
    details: Two deep-cloned views of your document. All mutations hit draft. Base stays committed until you call accept().
  - title: Diff
    details: Snapshot comparison between base and draft. Independent of the undo stack. Scoped to any JSONPath. Identity-aware for keyed arrays.
  - title: Undo / redo
    details: Every mutation — including accept() and decline() — pushes a reversible entry onto a linear stack. Ephemeral sessions collapse bursts into one entry.
  - title: Scoped lenses
    details: getNodeEngine() returns a zero-state lens onto a subtree. Reads and writes share parent state. diff(), accept(), and decline() are scoped to the subtree.
  - title: Array diffing
    details: Declare x-key on an array and patchwork matches elements by identity, not position. x-ordered surfaces displacement as move ops. $self handles primitive sets.
  - title: LLM-ready
    details: createEngineTools() produces a framework-neutral tool set. The LLM writes to draft; the human commits. Scope it to a subtree with a NodeEngine.
---
