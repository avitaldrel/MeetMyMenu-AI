// The saved "when you open a menu" preference.
//
// Reported by Jonathan Mosen (National Federation of the Blind): "It would be
// great if in Settings, a user can save a preference for whether they want the
// self-voicing feature on by default. I would never want the app to talk to me
// and for me to talk back to it. I'd always want to browse the menus with
// VoiceOver."
//
// The silent mode already existed (Browse Menu), but it lived only in React
// state, so it reset to Conversation on every launch and had to be re-chosen
// each time. These tests pin that the choice survives a reload.
import { test } from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(k: string) { return this.store.has(k) ? this.store.get(k)! : null; }
  setItem(k: string, v: string) { this.store.set(k, String(v)); }
  removeItem(k: string) { this.store.delete(k); }
  clear() { this.store.clear(); }
  key(i: number) { return [...this.store.keys()][i] ?? null; }
  get length() { return this.store.size; }
}
(globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();

import { loadProfile } from '../src/lib/storage.ts';
import { EMPTY_PROFILE } from '../src/types.ts';

const PROFILE_KEY = 'menuvoice.profile.v1';

test('a brand-new profile opens menus in conversation mode', () => {
  assert.equal(EMPTY_PROFILE.menuOpenMode, 'conversation');
});

test('choosing the silent mode survives a reload', async () => {
  // What Settings writes.
  localStorage.setItem(PROFILE_KEY, JSON.stringify({ ...EMPTY_PROFILE, menuOpenMode: 'browse' }));
  const reloaded = await loadProfile();
  assert.equal(
    reloaded.menuOpenMode,
    'browse',
    'the preference must survive; otherwise it has to be re-chosen on every launch'
  );
});

test('a profile saved before this setting existed still loads, defaulting to conversation', async () => {
  // Forward-compatibility: existing users have no menuOpenMode key at all.
  const legacy = { ...EMPTY_PROFILE } as Record<string, unknown>;
  delete legacy.menuOpenMode;
  localStorage.setItem(PROFILE_KEY, JSON.stringify(legacy));
  const reloaded = await loadProfile();
  assert.equal(reloaded.menuOpenMode, 'conversation', 'existing users keep the behaviour they have today');
});

test('the stored value is the one the app reads back, not a normalized guess', async () => {
  for (const mode of ['conversation', 'browse'] as const) {
    localStorage.setItem(PROFILE_KEY, JSON.stringify({ ...EMPTY_PROFILE, menuOpenMode: mode }));
    assert.equal((await loadProfile()).menuOpenMode, mode);
  }
});
