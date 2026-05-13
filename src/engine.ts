import { paths, type JsonValue } from 'jsonpath-rfc9535';
import parse from 'jsonpath-rfc9535/parser';

export class Engine<T extends JsonValue = JsonValue> {
	base: T;

	constructor(base: T) {
		this.base = base;
	}

	add(jsonPath: string, value: any): void {
		// const segments = this.segmentsFrom(jsonPath);
		const normalizedPaths = this.jsonPathToNormalizedPaths(jsonPath);
		if (normalizedPaths.length === 0) {
			// treat as literal path to create if no matches
			// if the jsonPath contains any query selectors, throw an error
			// TODO - support this better
			if (jsonPath.includes('*')) {
				throw new Error(`Invalid JSONPath: ${jsonPath}`);
			}
			// e.g. 'a.b.c.d' creates { a: { b: { c: { d: value }}}}
			this.setAt(this.segmentsFrom(jsonPath), value);
			return;
		}
		console.log('Normalized paths:', normalizedPaths);
		// Reverse to preserve array indices when inserting at multiple positions
		for (let i = normalizedPaths.length - 1; i >= 0; i--) {
			const segments = this.segmentsFrom(normalizedPaths[i]);
			this.insertAt(segments, value);
		}
	}

	replace(jsonPath: string, value: any): void {
		const normalizedPaths = this.jsonPathToNormalizedPaths(jsonPath);
		for (const np of normalizedPaths) {
			this.setAt(this.segmentsFrom(np), value);
		}
	}

	delete(jsonPath: string): void {
		const normalizedPaths = this.jsonPathToNormalizedPaths(jsonPath);
		// Reverse to preserve array indices when removing multiple elements
		for (let i = normalizedPaths.length - 1; i >= 0; i--) {
			this.removeAt(this.segmentsFrom(normalizedPaths[i]));
		}
	}

	move(from: string, to: string): void {
	}

	copy(from: string, to: string): void {
	}

	// Uses the library parser to extract (string | number) segments from a JSONPath.
	// Works on both normalized paths (output of paths()) and simple literal paths.
	private segmentsFrom(jsonPath: string): (string | number)[] {
		const ast = parse(jsonPath);
		const segments: (string | number)[] = [];
		for (const segment of ast.segments) {
			const node = segment.node;
			if (node.type === 'MemberNameShorthand') {
				segments.push(node.value);
			} else if (node.type === 'BracketedSelection') {
				const selector = node.selectors[0];
				if (selector.type === 'NameSelector') {
					segments.push(selector.value);
				} else if (selector.type === 'IndexSelector') {
					segments.push(selector.value);
				}
			}
		}
		return segments;
	}


	private setAt(segments: any[], value: any): void {
		// basically, for every segment except the last, we try to access the next level.
		// if it doesn't exist, we create an object or array depending on the next segment type.
		// so for example, if we have segments ['a', 'b', 'c', 0, 'd'], we first check if base['a'] exists.
		// If not, we create it as an object (since the next segment is 'b').
		// Given that we've had to create b, we don't need to check to see if the rest exist as we know they don't
		// so we can just create them all in one go.
		// So C is created as an array since the next segment is an index
		// And then at that index we create the object 
		console.log(segments);
		let current: any = this.base;
		for (let i = 0; i < segments.length - 1; i++) {
			const segment = segments[i];
			const nextSegment = segments[i + 1];

			const next = current[segment];

			const canGoNext =
				next !== undefined &&
				next !== null &&
				typeof next === 'object';

			if (!canGoNext) {
				current[segment] = typeof nextSegment === 'number' ? [] : {};
			}

			current = current[segment];
		}

		const finalSegment = segments[segments.length - 1];
		current[finalSegment] = value;
	}

	// add semantics: splices into arrays, sets on objects
	private insertAt(segments: (string | number)[], value: any): void {
		if (segments.length === 0) { this.base = value as T; return; }
		let current: any = this.base;
		for (let i = 0; i < segments.length - 1; i++) current = current[segments[i]];
		const key = segments[segments.length - 1];
		if (Array.isArray(current) && typeof key === 'number') {
			current.splice(key, 0, value);
		} else {
			current[key] = value;
		}
	}

	private removeAt(segments: (string | number)[]): void {
		if (segments.length === 0) return;
		let current: any = this.base;
		for (let i = 0; i < segments.length - 1; i++) current = current[segments[i]];
		const key = segments[segments.length - 1];
		if (Array.isArray(current) && typeof key === 'number') {
			current.splice(key, 1);
		} else {
			delete current[key as string];
		}
	}

	// jsonPath is a query selector, not a JSON Pointer. We need to convert it to a JSON Pointer before we can use it.
	// '$.store.book[*].author'; as an example
	private jsonPathToNormalizedPaths(jsonPath: string): string[] {
		return paths(this.base, jsonPath);
	}
}

// Test
const engine = new Engine({ a: {b: 3} });
engine.add('$.a.b.c[0].d', 5);
console.log(engine.base);
console.log(engine.base.a.b.c[0].d);
engine.add('$.a.b', 3);
console.log(engine.base);
engine.add('$.a.b', []);
engine.add('$.a.b[0]', 1);
console.log(engine.base);