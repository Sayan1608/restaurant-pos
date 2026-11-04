import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH } from '@pos/contracts';
import { describe, expect, it } from 'vitest';

import { HashingService } from './hashing.service.js';

const hashing = new HashingService();

describe('password and PIN hashing', () => {
  it('produces an Argon2id hash with the OWASP-recommended parameters', async () => {
    const result = await hashing.hashSecret('a-real-password');

    // The encoded form carries algorithm, version and parameters, which is
    // what allows the cost to be raised later without invalidating old hashes.
    expect(result).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it('verifies the right secret and rejects the wrong one', async () => {
    const stored = await hashing.hashSecret('1234');

    await expect(hashing.verifySecret(stored, '1234')).resolves.toBe(true);
    await expect(hashing.verifySecret(stored, '1235')).resolves.toBe(false);
    await expect(hashing.verifySecret(stored, '')).resolves.toBe(false);
  });

  it('salts: the same PIN hashes differently every time', async () => {
    const first = await hashing.hashSecret('1234');
    const second = await hashing.hashSecret('1234');

    // Without a unique salt, every cashier using 1234 would share a hash and a
    // single cracked value would open every till in the country.
    expect(first).not.toBe(second);
    await expect(hashing.verifySecret(first, '1234')).resolves.toBe(true);
    await expect(hashing.verifySecret(second, '1234')).resolves.toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['not a hash at all', 'definitely-not-a-hash'],
    ['a truncated hash', '$argon2id$v=19$m=19456'],
    ['a bcrypt hash', '$2b$12$abcdefghijklmnopqrstuv'],
  ])('reads %s as a failed verification rather than throwing', async (_label, stored) => {
    // A corrupt or absent hash must mean "wrong credential", never a 500 --
    // a 500 tells an attacker they have found something unusual.
    await expect(hashing.verifySecret(stored, '1234')).resolves.toBe(false);
  });

  it('spends real time on a dummy verification', async () => {
    // The point of verifyDummy is to make a missing account cost the same as a
    // wrong password. If it ever became a no-op, the login endpoint would turn
    // into a user-enumeration oracle, so assert it actually does work.
    const started = performance.now();
    await hashing.verifyDummy();
    expect(performance.now() - started).toBeGreaterThan(1);
  });
});

describe('opaque tokens', () => {
  it('is 256 bits, URL-safe', () => {
    const token = hashing.generateOpaqueToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes base64url, unpadded.
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => hashing.generateOpaqueToken()));
    expect(tokens.size).toBe(500);
  });
});

describe('fingerprints', () => {
  it('is a stable SHA-256 hex digest', () => {
    const token = 'a-device-token';
    const first = hashing.fingerprint(token);

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    // Must be deterministic: the column is looked up by equality, so the same
    // token has to produce the same value on every process and every machine.
    expect(hashing.fingerprint(token)).toBe(first);
  });

  it('differs for different tokens', () => {
    expect(hashing.fingerprint('token-a')).not.toBe(hashing.fingerprint('token-b'));
  });

  it('compares in constant time, and length-safely', () => {
    const a = hashing.fingerprint('x');
    expect(hashing.fingerprintsMatch(a, a)).toBe(true);
    expect(hashing.fingerprintsMatch(a, hashing.fingerprint('y'))).toBe(false);
    // Different lengths must not throw -- timingSafeEqual does if they differ.
    expect(hashing.fingerprintsMatch(a, 'short')).toBe(false);
  });
});

describe('pairing codes', () => {
  it('uses only the readable alphabet, at the stated length', () => {
    for (let index = 0; index < 200; index += 1) {
      const code = hashing.generatePairingCode();
      expect(code).toHaveLength(PAIRING_CODE_LENGTH);
      for (const character of code) {
        expect(PAIRING_CODE_ALPHABET).toContain(character);
      }
    }
  });

  it('excludes the characters people misread aloud', () => {
    // A code is read out across a counter, so 0/O, 1/I/L and U are omitted.
    for (const confusable of ['0', 'O', '1', 'I', 'L', 'U']) {
      expect(PAIRING_CODE_ALPHABET).not.toContain(confusable);
    }
  });

  it('is drawn uniformly, not biased towards the start of the alphabet', () => {
    // `Math.random() * n` with rejection done wrong skews towards low indices.
    // 12,000 codes over 30 symbols is ~3,200 expected per symbol; a naive
    // modulo bias would show up as a visible gradient.
    const counts = new Map<string, number>();
    for (let index = 0; index < 1_500; index += 1) {
      for (const character of hashing.generatePairingCode()) {
        counts.set(character, (counts.get(character) ?? 0) + 1);
      }
    }

    expect(counts.size).toBe(PAIRING_CODE_ALPHABET.length);

    const frequencies = [...counts.values()];
    const expected = (1_500 * PAIRING_CODE_LENGTH) / PAIRING_CODE_ALPHABET.length;
    for (const frequency of frequencies) {
      // Generous band: this is a smoke test for gross bias, not a chi-squared.
      expect(frequency).toBeGreaterThan(expected * 0.6);
      expect(frequency).toBeLessThan(expected * 1.4);
    }
  });

  it('does not repeat in any realistic window', () => {
    const codes = new Set(Array.from({ length: 2_000 }, () => hashing.generatePairingCode()));
    expect(codes.size).toBe(2_000);
  });
});
