import { randomUUID } from '../lib/random-uuid.ts'

const SAFE_DUMP_OPEN_CLIENT_ID = /^[A-Za-z0-9_-]{1,128}$/

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
