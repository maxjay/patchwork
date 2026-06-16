import type Ajv from 'ajv';
import type { ErrorObject } from 'ajv';

// Ajv's ErrorObject extended with a JSONPath-format path field.
// All original Ajv fields are preserved; `path` is added alongside
// `instancePath` (which remains in JSON Pointer format as Ajv emits it).
export type ValidationError = ErrorObject & { path: string };

// Converts Ajv's JSON Pointer instancePath (/users/0/email) to patchwork's
// bracket-notation JSONPath ($['users'][0]['email']).
function toJsonPath(instancePath: string): string {
	if (!instancePath) return '$';
	return '$' + instancePath
		.split('/')
		.slice(1)
		.map(seg => (/^\d+$/).test(seg) ? `[${seg}]` : `['${seg}']`)
		.join('');
}

// Validates engine.draft against the given schema using your Ajv instance.
// Configure Ajv however you need ($data, ajv-formats, custom keywords, etc.)
// before passing it in — this function just runs the validation and maps
// error paths to patchwork's JSONPath format.
export function validate(engine: { draft: unknown }, ajv: Ajv, schema: object): ValidationError[] {
	const fn = ajv.compile(schema);
	fn(engine.draft);
	return (fn.errors ?? []).map(err => ({ ...err, path: toJsonPath(err.instancePath) }));
}
