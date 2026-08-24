import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Context } from 'hono'

const PROOF_PARAM = '_1f3d9_cookie_proof'
const ATTEMPT_PARAM = '_1f3d9_cookie_attempt'
const SLOT_PARAM = '_1f3d9_cookie_slot'
const ISSUED_PARAM = '_1f3d9_cookie_issued'
const OPAQUE = /^[0-9a-f]{64}$/u
const COOKIE = /^([0-9a-f]{64})\.([0-9a-f]{64})$/u
const SLOT = /^[0-9a-f]{32}$/u
const ISSUED = /^(?:0|[1-9][0-9]{0,10})$/u

export const BROWSER_COOKIE_RETRY_WINDOW_SECONDS = 60

export interface BrowserSessionCookie {
  raw: string
  session: string
  csrf: string
}

export type BrowserCookieProof =
  | { kind: 'issue'; attempt: 0 | 1; slot: string; url: URL }
  | { kind: 'verified'; cookie: BrowserSessionCookie; slot: string; url: URL }
  | { kind: 'invalid'; url: URL }
  | {
    kind: 'failed'
    reason: 'browser_cookie_not_returned' | 'browser_cookie_mismatch'
    url: URL
  }

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function equalHex(left: string, right: string): boolean {
  if (!OPAQUE.test(left) || !OPAQUE.test(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

function namedCookie(c: Context, name: string): string | null {
  for (const part of (c.req.header('cookie') ?? '').split(';')) {
    const [candidate, ...value] = part.trim().split('=')
    if (candidate === name) return value.join('=') || null
  }
  return null
}

export function newBrowserSessionCookie(): BrowserSessionCookie {
  const session = randomBytes(32).toString('hex')
  const csrf = randomBytes(32).toString('hex')
  return { raw: `${session}.${csrf}`, session, csrf }
}

export function newBrowserSessionSlot(): string {
  return randomBytes(16).toString('hex')
}

export function browserSessionCookieName(baseName: string, slot: string): string {
  if (!SLOT.test(slot)) throw new Error('browser session cookie slot is invalid')
  return `${baseName}_${slot}`
}

export function parseBrowserSessionCookie(raw: string | null): BrowserSessionCookie | null {
  if (!raw) return null
  const current = COOKIE.exec(raw)
  if (current) return { raw, session: current[1]!, csrf: current[2]! }
  return null
}

export function readBrowserSessionCookie(
  c: Context,
  name: string,
  slot?: string | null,
): BrowserSessionCookie | null {
  if (slot && !SLOT.test(slot)) return null
  const cookieName = slot ? browserSessionCookieName(name, slot) : name
  return parseBrowserSessionCookie(namedCookie(c, cookieName))
}

export function inspectBrowserCookieProof(
  c: Context,
  name: string,
  now = Date.now(),
): BrowserCookieProof {
  const url = new URL(c.req.url)
  const proofs = url.searchParams.getAll(PROOF_PARAM)
  const attempts = url.searchParams.getAll(ATTEMPT_PARAM)
  const slots = url.searchParams.getAll(SLOT_PARAM)
  const issuedValues = url.searchParams.getAll(ISSUED_PARAM)
  url.searchParams.delete(PROOF_PARAM)
  url.searchParams.delete(ATTEMPT_PARAM)
  url.searchParams.delete(SLOT_PARAM)
  url.searchParams.delete(ISSUED_PARAM)

  if (
    proofs.length === 0 && attempts.length === 0 && slots.length === 0 &&
    issuedValues.length === 0
  ) {
    return { kind: 'issue', attempt: 0, slot: newBrowserSessionSlot(), url }
  }
  if (
    proofs.length !== 1 || attempts.length !== 1 || slots.length !== 1 ||
    issuedValues.length !== 1 || !OPAQUE.test(proofs[0]!) ||
    !['0', '1'].includes(attempts[0]!) || !SLOT.test(slots[0]!) ||
    !ISSUED.test(issuedValues[0]!)
  ) return { kind: 'invalid', url }

  const slot = slots[0]!
  const issuedAt = Number(issuedValues[0]!)
  const nowSeconds = Math.floor(now / 1_000)
  if (!Number.isSafeInteger(issuedAt) || issuedAt > nowSeconds + BROWSER_COOKIE_RETRY_WINDOW_SECONDS) {
    return { kind: 'invalid', url }
  }
  const raw = namedCookie(c, browserSessionCookieName(name, slot))
  const cookie = parseBrowserSessionCookie(raw)
  if (cookie && equalHex(digest(cookie.raw), proofs[0]!)) return { kind: 'verified', cookie, slot, url }
  const stale = nowSeconds - issuedAt > BROWSER_COOKIE_RETRY_WINDOW_SECONDS
  if (stale) return { kind: 'issue', attempt: 0, slot, url }
  if (raw === null) {
    return attempts[0] === '0'
      ? { kind: 'issue', attempt: 1, slot, url }
      : { kind: 'failed', reason: 'browser_cookie_not_returned', url }
  }
  return attempts[0] === '0'
    ? { kind: 'issue', attempt: 1, slot, url }
    : { kind: 'failed', reason: 'browser_cookie_mismatch', url }
}

export function browserCookieProofLocation(
  url: URL,
  cookie: BrowserSessionCookie,
  slot: string,
  attempt: 0 | 1,
  now = Date.now(),
): string {
  const target = new URL(url)
  target.hash = ''
  target.searchParams.set(PROOF_PARAM, digest(cookie.raw))
  target.searchParams.set(ATTEMPT_PARAM, String(attempt))
  target.searchParams.set(SLOT_PARAM, slot)
  target.searchParams.set(ISSUED_PARAM, String(Math.floor(now / 1_000)))
  return `${target.pathname}${target.search}`
}

export function setBrowserSessionCookie(c: Context, name: string, value: string): void {
  c.header('Set-Cookie', `${name}=${value}; Path=/; Max-Age=900; Secure; HttpOnly; SameSite=Lax`)
}

export function clearBrowserSessionCookie(c: Context, name: string): void {
  c.header('Set-Cookie', `${name}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`)
}
