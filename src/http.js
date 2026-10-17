// -----------------------------------------------------------------------------
// The only network access: HTTPS requests to Google and Nest, and the errors
// they end with. The body read is bounded, the promise settles once, nothing
// secret (cookies, tokens, the issue_token URL) ever goes into an error
// message.
// -----------------------------------------------------------------------------

import https from 'node:https';
import http from 'node:http';
import { LIMITS, TIMINGS } from './constants.js';

/**
 * A failed Google / Nest call. `kind`:
 * - `no_credentials`, `bad_format`: nothing sent;
 * - `refused`: Google refused the cookies or the issue_token (signed out,
 *   expired, another account): a stop until the user acts;
 * - `nest_refused`: Nest refused the token Google had just given (JWT or
 *   session step): spaced retries;
 * - `unauthorized`: Nest refused the session token (401/403) on a read;
 * - `rate_limited`: 429, `retryAfter` in ms when given;
 * - `gateway`: 502/504 of the long poll (pynest pauses 2 minutes);
 * - `unavailable`: other 5xx; `network`, `timeout`: no answer; `aborted`;
 * - `bad_response`, `size`: not the expected answer; `http`: any other status.
 */
export class NestError extends Error {
  constructor(kind, message, { status, retryAfter } = {}) {
    super(message);
    this.name = 'NestError';
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

const NETWORK_REASONS = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  ENOTFOUND: 'unknown host name',
  EAI_AGAIN: 'host name not resolved',
  ETIMEDOUT: 'connection timed out',
  EPIPE: 'connection closed',
};

/** A socket error -> NestError (never the request: it carries cookies and tokens). */
export function networkError(err) {
  if (err instanceof NestError) {
    return err;
  }
  if (err?.name === 'AbortError') {
    return new NestError('aborted', 'request cancelled');
  }
  return new NestError('network', NETWORK_REASONS[err?.code] ?? 'network error');
}

/** A short, secret-free reason for a log or a status message. */
export function errorReason(err) {
  if (err instanceof NestError) {
    return err.status ? `${err.message} (HTTP ${err.status})` : err.message;
  }
  return 'unexpected error';
}

/** One request; resolves `{ status, headers, body }` whatever the status. */
export function httpRequest(
  url,
  {
    method = 'GET',
    headers = {},
    body,
    timeout = TIMINGS.requestTimeout,
    maxBytes = LIMITS.responseBytes,
    signal,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    let timer;
    let settled = false;
    let req;
    const onAbort = () => {
      settle(reject, new NestError('aborted', 'request cancelled'));
      req?.destroy();
    };
    const settle = (fn, value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn(value);
      }
    };
    if (signal?.aborted) {
      settle(reject, new NestError('aborted', 'request cancelled'));
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    req = lib.request(target, { method, headers }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          settle(reject, new NestError('size', 'answer too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () =>
        settle(resolve, {
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      res.on('error', (err) => settle(reject, networkError(err)));
    });
    timer = setTimeout(
      () => {
        settle(
          reject,
          new NestError('timeout', `no answer within ${Math.round(timeout / 1000)} s`),
        );
        req.destroy();
      },
      Math.max(1, timeout),
    );
    req.on('error', (err) => settle(reject, networkError(err)));
    req.end(body);
  });
}

/** Retry-After (seconds or an HTTP date) -> milliseconds, undefined when absent. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** The JSON of a body; undefined when it is empty or not JSON. */
export function tryJson(body) {
  if (typeof body !== 'string' || body.trim() === '') {
    return undefined;
  }
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** The transient errors shared by every host: 429, 5xx. Undefined otherwise. */
export function transientError({ status, headers = {} }, now) {
  if (status === 429) {
    return new NestError('rate_limited', 'too many requests', {
      status,
      retryAfter: parseRetryAfter(headers['retry-after'], now),
    });
  }
  if (status >= 500) {
    return new NestError('unavailable', 'the service is unavailable', { status });
  }
  return undefined;
}
