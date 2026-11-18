/**
 * Generic per-record registry over an internal `KeyValueStore` (one of `__STORAGES__` / `__USERS__` /
 * `__ACTORS__` / `__RUNS__` / `__BUILDS__` / `__TASKS__` / `__WEBHOOKS__` / `__WEBHOOK_DISPATCHES__` /
 * `__SCHEDULES__` / `__LOGS__` / `__FILES__`). Never routable from the public
 * API - the API only resolves ids found in the matching registry, so these stores are unreachable by
 * construction (they are never opened by an id an external caller could guess into a public route).
 */
import type { KeyValueStore } from '@crawlee/core';

import { openKeyValueStore } from './open.js';
import { KeyedMutex } from './mutex.js';

/** Called after a write lands, inside the same per-id lock, with the record before and after it. */
export type RegistryChangeListener<T> = (previous: T | null, next: T | null) => void;

/** Translates between a record and what is written to disk, for a registry whose records must not be
 * stored as they are held in memory (`__USERS__`' tokens, `services/user-codec.ts`). */
export interface RecordCodec<T> {
	encode(value: T): unknown;
	decode(stored: unknown): T;
}

const identityCodec: RecordCodec<never> = { encode: (value) => value, decode: (stored) => stored as never };

export class Registry<T> {
	private readonly listeners = new Set<RegistryChangeListener<T>>();

	private constructor(
		private readonly store: KeyValueStore,
		private readonly mutex: KeyedMutex,
		private readonly codec: RecordCodec<T>,
	) {}

	static async open<T>(name: string, codec: RecordCodec<T> = identityCodec): Promise<Registry<T>> {
		const store = await openKeyValueStore(name);
		return new Registry<T>(store, new KeyedMutex(), codec);
	}

	private async load(id: string): Promise<T | null> {
		const stored = await this.store.getValue(id);
		return stored === null || stored === undefined ? null : this.codec.decode(stored);
	}

	private save(id: string, value: T | null): Promise<void> {
		return this.store.setValue(id, value === null ? null : this.codec.encode(value));
	}

	/** Serialised with writes to the same id: a read racing a delete can otherwise fail in the store. */
	async get(id: string): Promise<T | null> {
		return this.read(id);
	}

	private read(id: string): Promise<T | null> {
		return this.mutex.run(id, () => this.load(id));
	}

	async set(id: string, value: T): Promise<void> {
		await this.mutex.run(id, async () => {
			const previous = this.listeners.size > 0 ? await this.load(id) : null;
			await this.save(id, value);
			this.notify(previous, value);
		});
	}

	/** Read-modify-write, serialised per id. Returning `null` from `mutator` deletes the record. */
	async update(id: string, mutator: (current: T | null) => T | null): Promise<T | null> {
		return this.mutex.run(id, async () => {
			const current = await this.load(id);
			const next = mutator(current);
			await this.save(id, next);
			this.notify(current, next);
			return next;
		});
	}

	async delete(id: string): Promise<void> {
		await this.mutex.run(id, () => this.store.setValue(id, null));
	}

	/** Returns the unsubscribe function. A listener must not write to this registry synchronously. */
	onChange(listener: RegistryChangeListener<T>): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(previous: T | null, next: T | null): void {
		for (const listener of this.listeners) {
			try {
				listener(previous, next);
			} catch (error) {
				console.error('Registry change listener failed:', error);
			}
		}
	}

	/** All non-deleted records, in no particular order. Fine at POC scale (<100 records per type). */
	async list(): Promise<T[]> {
		const ids: string[] = [];
		await this.store.forEachKey(async (key) => {
			ids.push(key);
		});
		const values = await Promise.all(ids.map((id) => this.read(id)));
		return values.filter((value) => value !== null);
	}
}
