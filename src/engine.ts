import { paths, type JsonValue } from 'jsonpath-rfc9535';
import parse from 'jsonpath-rfc9535/parser';

export class Engine<T extends JsonValue = JsonValue> {
	base: T;

	constructor(base: T) {
		this.base = base;
	}

	add(jsonPath: string, value: any): void {
		const normalizedPaths = this.jsonPathToNormalizedPaths(jsonPath);
		for (const normalizedPath of normalizedPaths) {
			const ast = parse(normalizedPath);
			for (const segment of ast.segments) {
				console.log(segment.node);
			}
		}
	}

	replace(jsonPath: string, value: any): void {
	}

	delete(jsonPath: string): void {
	}

	move(from: string, to: string): void {
	}

	copy(from: string, to: string): void {
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