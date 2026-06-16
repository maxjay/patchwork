# @maxjay/patchwork-ajv

Ajv JSON Schema validation add-on for [@maxjay/patchwork](https://github.com/maxjay/patchwork).

## Install

```bash
npm install @maxjay/patchwork-ajv ajv
```

## Usage

```ts
import Ajv from 'ajv';
import { validate } from '@maxjay/patchwork-ajv';

const ajv = new Ajv({ $data: true, allErrors: true, strict: false });

const errors = validate(engine, ajv, schema);
```

You bring your own Ajv instance — configure it however you need (`$data`, `ajv-formats`, custom keywords, plugins). This package handles two things: reading `engine.draft` and mapping Ajv's error paths from JSON Pointer to patchwork's JSONPath format.

Works with both `Engine` directly and `PatchworkStore` (Angular):

```ts
// Engine
const engine = new Engine(data, { schema });
const errors = validate(engine, ajv, schema);

// Angular store
const store = createPatchworkStore(data, { schema });
const errors = validate(store.engine, ajv, schema);
```

## Error shape

Each error is Ajv's [`ErrorObject`](https://ajv.js.org/api.html#error-objects) with one extra field:

| Field | Description |
|---|---|
| `path` | JSONPath to the failing value: `$['users'][0]['email']` |
| `keyword` | JSON Schema keyword: `type`, `required`, `minimum`, … |
| `message` | Human-readable message from Ajv |
| `instancePath` | Original JSON Pointer from Ajv: `/users/0/email` |
| `params` | Keyword-specific details (e.g. `{ missingProperty: 'name' }`) |

## Example with ajv-formats

```ts
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { validate } from '@maxjay/patchwork-ajv';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const schema = {
  type: 'object',
  properties: {
    email: { type: 'string', format: 'email' },
    start: { type: 'string', format: 'date' },
    end:   { type: 'string', format: 'date', formatMinimum: { $data: '1/start' } },
  },
};

const errors = validate(engine, ajv, schema);
```

## Peer dependencies

- `@maxjay/patchwork >= 0.18.0`
- `ajv >= 8.0.0` (install separately — you own the instance)
