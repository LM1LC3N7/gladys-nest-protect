// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container). Never the cookies, never the issue_token, never the e-mail:
//   - a random salt made once (for the fingerprints below);
//   - the Nest session (its access token, user id, end and transport URL),
//     the one token strictly needed so a restart does not ask Google again
//     (ha-nest-protect keeps it too), tied to a salted fingerprint of the
//     issue_token; written only when it changes;
//   - a stop (Google refused the cookies; Nest refused a fresh session, with
//     its spaced retries), tied to a salted fingerprint of the issue_token
//     and the cookies, so a restart never tries again what was refused, and
//     new cookies do;
//   - the end of a 429 pause.
// The file is readable by the container user only (0600).
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { open, readFile, rename } from 'node:fs/promises';
import { TIMINGS } from './constants.js';
import { trustedTransport } from './client.js';

export const STATE_FILE = '/data/nest-protect-state.json';

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, 'utf8'));
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        const file = await open(temporary, 'w', 0o600);
        try {
          await file.writeFile(text);
          // On disk before it replaces the previous state (a power cut keeps one of the two).
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

export const newSalt = () => randomBytes(16).toString('hex');

/** A salted fingerprint (16 hex digits): which credentials a session or a stop belongs to. */
export const fingerprint = (salt, ...parts) =>
  createHash('sha256')
    .update([salt, ...parts].join('\n'))
    .digest('hex')
    .slice(0, 16);

const HEX16 = /^[0-9a-f]{16}$/;
const BLOCKS = new Set(['refused', 'session_refused']);

function session(raw) {
  const s = raw?.session;
  if (
    !HEX16.test(s?.account ?? '') ||
    typeof s.accessToken !== 'string' ||
    s.accessToken === '' ||
    s.accessToken.length > 8192 ||
    typeof s.userId !== 'string' ||
    !/^[A-Za-z0-9_.-]{1,64}$/.test(s.userId) ||
    !Number.isFinite(s.expiresAt)
  ) {
    return null;
  }
  return {
    account: s.account,
    accessToken: s.accessToken,
    userId: s.userId,
    expiresAt: s.expiresAt,
    transportUrl: trustedTransport(s.transportUrl),
  };
}

/** The persisted state, repaired; the pause and retry ends are capped from `now`. */
export function normalizeMemory(raw, now = Date.now()) {
  const block = raw?.block;
  const capped = (value, max) => (Number.isFinite(value) ? Math.min(value, now + max) : undefined);
  const lastRetry = TIMINGS.sessionRetry[TIMINGS.sessionRetry.length - 1];
  return {
    salt: typeof raw?.salt === 'string' && /^[0-9a-f]{32}$/.test(raw.salt) ? raw.salt : null,
    session: session(raw),
    rateLimitedUntil: capped(raw?.rateLimitedUntil, TIMINGS.rateLimitMax),
    block:
      BLOCKS.has(block?.kind) && HEX16.test(block?.fingerprint ?? '')
        ? {
            kind: block.kind,
            fingerprint: block.fingerprint,
            retryAt:
              block.kind === 'session_refused' ? capped(block.retryAt, lastRetry) : undefined,
            retries:
              Number.isInteger(block.retries) && block.retries >= 0
                ? Math.min(block.retries, 10)
                : 0,
          }
        : null,
  };
}
