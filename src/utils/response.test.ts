import { describe, expect, it } from 'vitest';
import { errorFromCatch, textContent } from './response.js';

describe('errorFromCatch', () => {
  it('returns the message from an Error instance', () => {
    const result = errorFromCatch(new Error('connection failed'));

    expect(result.isError).toBe(true);
    expect(textContent(result.content[0])).toBe('Error: connection failed');
  });

  it.each([
    [{ message: 'invalid password' }, 'invalid password'],
    [{ error: 'budget unavailable' }, 'budget unavailable'],
    [{ reason: 'sync failed' }, 'sync failed'],
    [{ error: new Error('nested failure') }, 'nested failure'],
  ])('extracts a useful message from structured thrown values', (thrown, expected) => {
    const result = errorFromCatch(thrown);

    expect(textContent(result.content[0])).toBe(`Error: ${expected}`);
  });

  it('does not leak opaque object details', () => {
    const result = errorFromCatch({ token: 'secret', internalState: 42 });

    expect(textContent(result.content[0])).toBe('Error: Unexpected error. Check the server logs for details.');
  });
});
