import { computed, signal, type Signal, type WritableSignal } from '@angular/core';
import type { JsonValue } from 'jsonpath-rfc9535';
import { Engine, NodeEngine, type DiffOp } from './engine.js';

// The store mutates engine.draft / engine.base in place and re-exposes the
// same references. Angular's default reference equality would skip propagation
// — so every read computed declares this equality to force propagation.
const neverEqual = () => false;

// Angular Signals adapter for the patchwork Engine.
//
// The store wraps an Engine (or NodeEngine via scope) and exposes reactive
// reads as Signals. All engine mutations are forwarded; after each, the
// internal "tick" signals are fired so any dependent computeds re-evaluate.
//
// Two pieces of state per store tree (root + scopes share them):
//   _draftTick — bumped after every mutation that affects draft
//   _baseTick  — bumped after every accept (or undo/redo that moves base)
//
// The ticks are WritableSignal<unknown> with equal: () => false, so even
// re-setting the same reference fires the change. This avoids structuredClone
// on every mutation while keeping reactivity correct.

export interface PatchworkStore<T extends JsonValue = JsonValue> {
	readonly draft: Signal<T>;
	readonly base: Signal<T>;
	readonly engine: Engine<T> | NodeEngine<T>;

	get(path: string): Signal<Array<{ path: string; value: JsonValue }>>;
	getBase(path: string): Signal<Array<{ path: string; value: JsonValue }>>;
	getValue(path: string): Signal<JsonValue>;
	getValueBase(path: string): Signal<JsonValue>;
	diff(path?: string, options?: { key?: string }): Signal<DiffOp[]>;

	add(path: string, value: any): void;
	replace(path: string, value: any): void;
	delete(path: string): void;
	move(from: string, to: string): void;
	copy(from: string, to: string): void;
	revert(path: string): void;

	undo(): void;
	redo(): void;
	accept(): void;
	decline(): void;

	beginEphemeral(): void;
	commitEphemeral(): void;
	discardEphemeral(): void;

	scope<U extends JsonValue = JsonValue>(path: string): PatchworkStore<U>;
}

class PatchworkStoreImpl<T extends JsonValue> implements PatchworkStore<T> {
	readonly engine: Engine<T> | NodeEngine<T>;
	private readonly _draftTick: WritableSignal<unknown>;
	private readonly _baseTick: WritableSignal<unknown>;
	readonly draft: Signal<T>;
	readonly base: Signal<T>;

	constructor(
		engine: Engine<JsonValue> | NodeEngine<JsonValue>,
		sharedDraftTick?: WritableSignal<unknown>,
		sharedBaseTick?: WritableSignal<unknown>,
	) {
		this.engine = engine as Engine<T> | NodeEngine<T>;
		this._draftTick = sharedDraftTick ?? signal<unknown>(null, { equal: () => false });
		this._baseTick = sharedBaseTick ?? signal<unknown>(null, { equal: () => false });

		this.draft = computed(() => {
			this._draftTick();
			return this.engine.draft as T;
		}, { equal: neverEqual });
		this.base = computed(() => {
			this._baseTick();
			return this.engine.base as T;
		}, { equal: neverEqual });
	}

	private fireDraft() { this._draftTick.set(null); }
	private fireBase() { this._baseTick.set(null); }

	get(path: string): Signal<Array<{ path: string; value: JsonValue }>> {
		return computed(() => {
			this._draftTick();
			return this.engine.get(path);
		}, { equal: neverEqual });
	}

	getBase(path: string): Signal<Array<{ path: string; value: JsonValue }>> {
		return computed(() => {
			this._baseTick();
			return this.engine.getBase(path);
		}, { equal: neverEqual });
	}

	getValue(path: string): Signal<JsonValue> {
		return computed(() => {
			this._draftTick();
			return this.engine.getValue(path);
		}, { equal: neverEqual });
	}

	getValueBase(path: string): Signal<JsonValue> {
		return computed(() => {
			this._baseTick();
			return this.engine.getValueBase(path);
		}, { equal: neverEqual });
	}

	diff(path?: string, options?: { key?: string }): Signal<DiffOp[]> {
		return computed(() => {
			this._draftTick();
			this._baseTick();
			return this.engine.diff(path, options);
		}, { equal: neverEqual });
	}

	add(path: string, value: any): void { this.engine.add(path, value); this.fireDraft(); }
	replace(path: string, value: any): void { this.engine.replace(path, value); this.fireDraft(); }
	delete(path: string): void { this.engine.delete(path); this.fireDraft(); }
	move(from: string, to: string): void { this.engine.move(from, to); this.fireDraft(); }
	copy(from: string, to: string): void { this.engine.copy(from, to); this.fireDraft(); }
	revert(path: string): void { this.engine.revert(path); this.fireDraft(); }

	undo(): void {
		this.engine.undo();
		// Either side could have moved (accept undo touches base, etc.) — fire both.
		this.fireDraft();
		this.fireBase();
	}

	redo(): void {
		this.engine.redo();
		this.fireDraft();
		this.fireBase();
	}

	accept(): void {
		this.engine.accept();
		this.fireBase();
	}

	decline(): void {
		this.engine.decline();
		this.fireDraft();
	}

	beginEphemeral(): void {
		if (!('beginEphemeral' in this.engine)) {
			throw new Error('beginEphemeral: not available on scoped stores (NodeEngine)');
		}
		(this.engine as Engine<T>).beginEphemeral();
	}

	commitEphemeral(): void {
		if (!('commitEphemeral' in this.engine)) {
			throw new Error('commitEphemeral: not available on scoped stores (NodeEngine)');
		}
		(this.engine as Engine<T>).commitEphemeral();
		this.fireDraft();
	}

	discardEphemeral(): void {
		if (!('discardEphemeral' in this.engine)) {
			throw new Error('discardEphemeral: not available on scoped stores (NodeEngine)');
		}
		(this.engine as Engine<T>).discardEphemeral();
		this.fireDraft();
	}

	scope<U extends JsonValue = JsonValue>(path: string): PatchworkStore<U> {
		const child = this.engine.getNodeEngine<U>(path);
		return new PatchworkStoreImpl<U>(
			child as NodeEngine<JsonValue>,
			this._draftTick,
			this._baseTick,
		);
	}
}

export function createPatchworkStore<T extends JsonValue = JsonValue>(
	base: T,
	options?: { schema?: Record<string, any> },
): PatchworkStore<T> {
	const engine = new Engine<T>(base, options);
	return new PatchworkStoreImpl<T>(engine as Engine<JsonValue>);
}

export function fromEngine<T extends JsonValue = JsonValue>(
	engine: Engine<T>,
): PatchworkStore<T> {
	return new PatchworkStoreImpl<T>(engine as Engine<JsonValue>);
}
