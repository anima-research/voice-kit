import assert from 'node:assert/strict';

/** Like bun:test's toMatchObject for the plain objects these tests compare:
 *  every key the expected object names must deep-equal the actual value's. */
export function assertMatches(actual: unknown, expected: Record<string, unknown>): void {
  assert.ok(actual !== null && typeof actual === 'object', `expected an object, got ${String(actual)}`);
  const picked: Record<string, unknown> = {};
  for (const key of Object.keys(expected)) picked[key] = (actual as Record<string, unknown>)[key];
  assert.deepEqual(picked, expected);
}
