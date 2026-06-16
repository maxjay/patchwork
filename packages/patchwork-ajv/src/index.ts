import Ajv, { type ErrorObject } from 'ajv';

export interface ValidationError {
	path: string;    // JSONPath: $['users'][0]['email']
	message: string; // human-readable Ajv message
	keyword: string; // JSON Schema keyword: 'type', 'required', 'minimum', etc.
}

export interface Validator {
	validate(value: unknown): ValidationError[];
}

// Converts an Ajv JSON Pointer instancePath (/users/0/email) to patchwork's
// bracket-notation JSONPath ($['users'][0]['email']).
function pointerToJsonPath(instancePath: string): string {
	if (!instancePath) return '$';
	return '$' + instancePath
		.split('/')
		.slice(1)
		.map(seg => (/^\d+$/).test(seg) ? `[${seg}]` : `['${seg}']`)
		.join('');
}

// Creates a compiled validator for the given JSON Schema.
// Compile once per schema; call validate() as many times as needed.
// Ajv resolves $ref/$defs automatically, so recursive and referenced schemas
// are validated in full — including vendor extensions like x-key/x-ordered
// which Ajv ignores safely (strict: false).
export function createValidator(schema: object): Validator {
	const ajv = new Ajv({ strict: false, allErrors: true });
	const fn = ajv.compile(schema);

	return {
		validate(value: unknown): ValidationError[] {
			fn(value);
			return (fn.errors ?? []).map((err: ErrorObject) => ({
				path: pointerToJsonPath(err.instancePath),
				message: err.message ?? 'validation error',
				keyword: err.keyword,
			}));
		},
	};
}
