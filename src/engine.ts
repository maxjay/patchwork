import { paths, type JsonValue } from 'jsonpath-rfc9535';
import parse from 'jsonpath-rfc9535/parser';

export class Engine<T extends JsonValue = JsonValue> {
	base: T;

	constructor(base: T) {
		this.base = base;
	}

	add(jsonPath: string, value: any): void {
		const normalizedPaths = this.jsonPathToNormalizedPaths(jsonPath);
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


	private setAt(segments: (string | number)[], value: any): void {
		if (segments.length === 0) { this.base = value as T; return; }
		let current: any = this.base;
		for (let i = 0; i < segments.length - 1; i++) current = current[segments[i]];
		current[segments[segments.length - 1]] = value;
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
engine.add('$.a.b', 5);
