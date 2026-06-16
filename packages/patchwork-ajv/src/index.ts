import Ajv, { type ErrorObject } from 'ajv';

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

// Validates engine.draft against a JSON Schema and returns all violations.
// Pass the Engine instance directly; the schema is the same one you passed
// to the Engine constructor.
//
// x-key and x-ordered vendor extensions are ignored by Ajv (strict: false).
// $ref and $defs are resolved automatically.
export function validate(engine: { draft: unknown }, schema: object): ValidationError[] {
	const ajv = new Ajv({ strict: false, allErrors: true });
	const fn = ajv.compile(schema);
	fn(engine.draft);
	return (fn.errors ?? []).map(err => ({ ...err, path: toJsonPath(err.instancePath) }));
}
