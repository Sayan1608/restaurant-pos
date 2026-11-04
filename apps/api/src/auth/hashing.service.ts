import { Injectable } from '@nestjs/common';
import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH } from '@pos/contracts';
import { Algorithm, hash, verify } from '@node-rs/argon2';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Every hashing decision in one place, because the right algorithm depends
 * entirely on what is being hashed.
 *
 * **Low-entropy human secrets -- passwords and PINs -- get Argon2id.** A
 * 4-digit PIN has 10,000 possibilities; the only thing standing between a
 * leaked database and a working PIN is how expensive each guess is. Argon2id
 * is memory-hard, so it resists GPU farms in a way SHA-family hashes do not.
 * Parameters follow the OWASP recommendation (19 MiB, 2 iterations, 1 lane).
 *
 * **High-entropy machine secrets -- device and refresh tokens -- get SHA-256.**
 * These are 256 bits of randomness; there is nothing to brute-force, so a slow
 * hash would buy no security while making every authenticated request slow.
 * A fast digest also means the column can be indexed and looked up directly.
 */
@Injectable()
export class HashingService {
  /** OWASP-recommended Argon2id parameters, February 2024 guidance. */
  private static readonly ARGON2_OPTIONS = {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19_456, // KiB == 19 MiB
    timeCost: 2,
    parallelism: 1,
  } as const;

  /**
   * A valid Argon2id hash of a value nobody knows, used to spend the same time
   * verifying a credential for an account that does not exist. Generated once
   * at startup from random bytes.
   */
  private readonly decoyHash: Promise<string>;

  constructor() {
    this.decoyHash = hash(randomBytes(32).toString('hex'), HashingService.ARGON2_OPTIONS);
  }

  /** Hash a password or PIN. The result is self-describing: it embeds the
   * algorithm, parameters and salt, so parameters can be raised later without
   * invalidating existing hashes. */
  async hashSecret(plain: string): Promise<string> {
    return hash(plain, HashingService.ARGON2_OPTIONS);
  }

  /**
   * Verify a password or PIN. Returns false rather than throwing on a
   * malformed or empty hash -- a corrupt row must read as "wrong credential",
   * never as a 500 that tells an attacker they found something interesting.
   */
  async verifySecret(storedHash: string | null | undefined, plain: string): Promise<boolean> {
    if (!storedHash) {
      // No credential set. Still spend the time, so "this cashier has no PIN"
      // is indistinguishable from "wrong PIN".
      await this.verifyDummy();
      return false;
    }
    try {
      return await verify(storedHash, plain);
    } catch {
      return false;
    }
  }

  /**
   * Burn one Argon2 verification against a decoy hash.
   *
   * Called when the account does not exist. Without it, a missing account
   * answers in microseconds while a real one takes ~26 ms, and the login
   * endpoint becomes a reliable oracle for which emails are registered.
   */
  async verifyDummy(): Promise<void> {
    try {
      await verify(await this.decoyHash, 'not the decoy value');
    } catch {
      // Never surfaces; the decoy is only here to consume time.
    }
  }

  /** 256 bits of randomness, URL-safe. Used for device and refresh tokens. */
  generateOpaqueToken(): string {
    return randomBytes(32).toString('base64url');
  }

  /**
   * Indexable fingerprint of a high-entropy token. The token itself is never
   * stored, so a database leak yields no usable credential.
   */
  fingerprint(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  /**
   * A pairing code a manager can read aloud. `randomInt` is drawn from the
   * CSPRNG and is uniform over the range -- `Math.random() * n` would be
   * neither.
   */
  generatePairingCode(): string {
    let code = '';
    for (let index = 0; index < PAIRING_CODE_LENGTH; index += 1) {
      code += PAIRING_CODE_ALPHABET[randomInt(0, PAIRING_CODE_ALPHABET.length)];
    }
    return code;
  }

  /**
   * Constant-time comparison of two hex fingerprints, for the rare case where
   * a fingerprint is compared in application code rather than by the database.
   */
  fingerprintsMatch(a: string, b: string): boolean {
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  }
}
