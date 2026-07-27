const SAFE_DUMP_OPEN_CLIENT_ID = /^[A-Za-z0-9_-]{1,128}$/

/**
 * Generate a UUID v4, falling back to a manual implementation when the
 * browser's `crypto.randomUUID` is unavailable (e.g. insecure contexts or
 * older browsers).
 */
function randomUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < 16; index++) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Create the private flag name owned by one dashboard tab.
 */
export function createDumpOpenLeaseFlag(clientId: string = randomUUID()): string {
  if (!SAFE_DUMP_OPEN_CLIENT_ID.test(clientId)) {
    throw new Error('Invalid dump-open client id')
  }

  return `dump-open:${clientId}`
}

/**
 * One stable lease for this JavaScript realm. Browser tabs have separate realms, so each tab
 * owns a different flag while every heartbeat and lifecycle event in that tab reuses one name.
 */
export const DUMP_OPEN_LEASE_FLAG = createDumpOpenLeaseFlag()
