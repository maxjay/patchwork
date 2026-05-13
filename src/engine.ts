import { paths, type JsonValue } from 'jsonpath-rfc9535';
import parse from 'jsonpath-rfc9535/parser';

export interface Operation {
	undo: () => void;
	redo: () => void;
}

export class Engine<T extends JsonValue = JsonValue> {
	base: T;
	private undoStack: Operation[] = [];
	private redoStack: Operation[] = [];

	constructor(base: T) {
		this.base = base;
	}

	private pushOperation(op: Operation) {
		this.undoStack.push(op);
		this.redoStack = [];
	}

	undo(): void {
		const op = this.undoStack.pop();
		if (op) {
			op.undo();
			this.redoStack.push(op);
		}
	}

	redo(): void {
		const op = this.redoStack.pop();
		if (op) {
			op.redo();
			this.undoStack.push(op);
		}
	}

	add(jsonPath: string, value: any): void {
		const normalizedPaths = this.jsonPathToNormalizedPaths(jsonPath);
		const segmentsList = normalizedPaths.map(np => this.segmentsFrom(np));

		const isArrayInsert = segmentsList.map(seg => {
			if (seg.length === 0) return false;
			let current: any = this.base;
			for (let i = 0; i < seg.length - 1; i++) current = current[seg[i]];
			return Array.isArray(current) && typeof seg[seg.length - 1] === 'number';
		});

		const oldValues = segmentsList.map(seg => structuredClone(this.getAt(seg)));
		const valueToInsert = structuredClone(value);

		const doAdd = () => {
			// Reverse to preserve array indices when inserting at multiple positions
			for (let i = segmentsList.length - 1; i >= 0; i--) {
				this.insertAt(segmentsList[i], structuredClone(valueToInsert));
			}
		};

		const undoAdd = () => {
			for (let i = 0; i < segmentsList.length; i++) {
				if (isArrayInsert[i]) {
					this.removeAt(segmentsList[i]);
				} else {
					this.setAt(segmentsList[i], structuredClone(oldValues[i]));
				}
			}
		};

		doAdd();
		this.pushOperation({ undo: undoAdd, redo: doAdd });
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

	private getAt(segments: (string | number)[]): any {
		if (segments.length === 0) return this.base;
		let current: any = this.base;
		for (let i = 0; i < segments.length - 1; i++) current = current[segments[i]];
		return current[segments[segments.length - 1]];
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
const engine = new Engine({ a: { b: 3 } });
engine.add('$.a.b', 5);
