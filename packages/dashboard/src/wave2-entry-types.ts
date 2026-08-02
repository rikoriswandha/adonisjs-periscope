import {
  Bell,
  Box,
  Braces,
  ClipboardCheck,
  CalendarClock,
  CircleGauge,
  DatabaseZap,
  Gauge,
  Globe2,
  HeartPulse,
  Handshake,
  HardDrive,
  KeyRound,
  Languages,
  LockKeyhole,
  Mail,
  PanelsTopLeft,
  Radio,
  RadioTower,
  ScrollText,
  ShieldCheck,
  PlugZap,
  SquareTerminal,
} from 'lucide-react'

import { registerEntryType } from '@/entry-type-registry'
import type { EntryTypeRegistration } from '@/entry-type-registry'
import { assertUniqueEntryTypeMetadata } from '@/lib/entry-type-registration'
import type { EntryType } from '@/types'

const eventsEntryType = registerEntryType({
  type: 'event',
  path: 'events',
  label: 'Events',
  group: 'Application',
  icon: Radio,
  load: () => import('@/pages/events-page').then((module) => module.eventsEntryTypeImplementation),
})

const logsEntryType = registerEntryType({
  type: 'log',
  path: 'logs',
  label: 'Logs',
  group: 'Diagnostics',
  icon: ScrollText,
  load: () => import('@/pages/logs-page').then((module) => module.logsEntryTypeImplementation),
})

const commandsEntryType = registerEntryType({
  type: 'command',
  path: 'commands',
  label: 'Commands',
  group: 'Application',
  icon: SquareTerminal,
  load: () =>
    import('@/pages/commands-page').then((module) => module.commandsEntryTypeImplementation),
})

const mailEntryType = registerEntryType({
  type: 'mail',
  path: 'mail',
  label: 'Mail',
  group: 'Application',
  icon: Mail,
  load: () => import('@/pages/mail-page').then((module) => module.mailEntryTypeImplementation),
})

const cacheEntryType = registerEntryType({
  type: 'cache',
  path: 'cache',
  label: 'Cache',
  group: 'Application',
  icon: DatabaseZap,
  load: () => import('@/pages/cache-page').then((module) => module.cacheEntryTypeImplementation),
})

const modelsEntryType = registerEntryType({
  type: 'model',
  path: 'models',
  label: 'Models',
  group: 'Application',
  icon: Box,
  load: () => import('@/pages/models-page').then((module) => module.modelsEntryTypeImplementation),
})

const gatesEntryType = registerEntryType({
  type: 'gate',
  path: 'gates',
  label: 'Gates',
  group: 'Application',
  icon: ShieldCheck,
  load: () => import('@/pages/gates-page').then((module) => module.gatesEntryTypeImplementation),
})

const viewsEntryType = registerEntryType({
  type: 'view',
  path: 'views',
  label: 'Views',
  group: 'Application',
  icon: PanelsTopLeft,
  load: () => import('@/pages/views-page').then((module) => module.viewsEntryTypeImplementation),
})

const dumpsEntryType = registerEntryType({
  type: 'dump',
  path: 'dumps',
  label: 'Dumps',
  group: 'Diagnostics',
  icon: Braces,
  load: () => import('@/pages/dumps-page').then((module) => module.dumpsEntryTypeImplementation),
})

const httpClientEntryType = registerEntryType({
  type: 'http_client',
  path: 'http-client',
  label: 'HTTP client',
  group: 'Diagnostics',
  icon: Globe2,
  load: () =>
    import('@/pages/http-client-page').then((module) => module.httpClientEntryTypeImplementation),
})

const schedulesEntryType = registerEntryType({
  type: 'schedule',
  path: 'schedules',
  label: 'Schedules',
  group: 'Application',
  icon: CalendarClock,
  load: () => import('@/pages/jobs-page').then((module) => module.schedulesEntryTypeImplementation),
})

const jobsEntryType = registerEntryType({
  type: 'job',
  path: 'jobs',
  label: 'Jobs',
  group: 'Application',
  icon: CircleGauge,
  load: () => import('@/pages/jobs-page').then((module) => module.jobsEntryTypeImplementation),
})

const broadcastsEntryType = registerEntryType({
  type: 'broadcast',
  path: 'broadcasts',
  label: 'Broadcasts',
  group: 'Infrastructure',
  icon: RadioTower,
  load: () =>
    import('@/pages/broadcasts-page').then((module) => module.broadcastsEntryTypeImplementation),
})

const healthChecksEntryType = registerEntryType({
  type: 'health_check',
  path: 'health-checks',
  label: 'Health checks',
  group: 'Infrastructure',
  icon: HeartPulse,
  load: () =>
    import('@/pages/health-checks-page').then(
      (module) => module.healthChecksEntryTypeImplementation
    ),
})

const redisEntryType = registerEntryType({
  type: 'redis',
  path: 'redis',
  label: 'Redis',
  group: 'Infrastructure',
  icon: DatabaseZap,
  load: () => import('@/pages/redis-page').then((module) => module.redisEntryTypeImplementation),
})

const sessionsEntryType = registerEntryType({
  type: 'session',
  path: 'sessions',
  label: 'Sessions',
  group: 'Infrastructure',
  icon: KeyRound,
  load: () =>
    import('@/pages/sessions-page').then((module) => module.sessionsEntryTypeImplementation),
})

const validationsEntryType = registerEntryType({
  type: 'validation',
  path: 'validations',
  label: 'Validations',
  group: 'Application',
  icon: ClipboardCheck,
  load: () =>
    import('@/pages/integration-entry-page').then((module) =>
      module.createIntegrationEntryTypeImplementation({
        heading: 'Validations',
        description: 'Inspect failed validation attempts and their field-level errors.',
      })
    ),
})

const rateLimitsEntryType = registerEntryType({
  type: 'rate_limit',
  path: 'rate-limits',
  label: 'Rate limits',
  group: 'Infrastructure',
  icon: Gauge,
  load: () =>
    import('@/pages/integration-entry-page').then((module) =>
      module.createIntegrationEntryTypeImplementation({
        heading: 'Rate limits',
        description: 'Track limiter decisions, consumption, and rejected attempts.',
      })
    ),
})

const locksEntryType = registerEntryType({
  type: 'lock',
  path: 'locks',
  label: 'Locks',
  group: 'Infrastructure',
  icon: LockKeyhole,
  load: () =>
    import('@/pages/integration-entry-page').then((module) =>
      module.createIntegrationEntryTypeImplementation({
        heading: 'Locks',
        description: 'Follow distributed lock acquisition, release, and contention.',
      })
    ),
})

const driveEntryType = registerEntryType({
  type: 'drive',
  path: 'drive',
  label: 'Drive',
  group: 'Infrastructure',
  icon: HardDrive,
  load: () =>
    import('@/pages/integration-entry-page').then((module) =>
      module.createIntegrationEntryTypeImplementation({
        heading: 'Drive',
        description: 'Inspect filesystem operations across configured Drive disks.',
      })
    ),
})

const allyEntryType = registerEntryType({
  type: 'ally',
  path: 'ally',
  label: 'OAuth (Ally)',
  group: 'Infrastructure',
  icon: Handshake,
  load: () =>
    import('@/pages/integration-entry-page').then((module) =>
      module.createIntegrationEntryTypeImplementation({
        heading: 'OAuth (Ally)',
        description: 'Follow OAuth redirects, callbacks, and provider outcomes.',
      })
    ),
})

const i18nEntryType = registerEntryType({
  type: 'i18n',
  path: 'i18n',
  label: 'I18n',
  group: 'Infrastructure',
  icon: Languages,
  load: () =>
    import('@/pages/integration-entry-page').then((module) =>
      module.createIntegrationEntryTypeImplementation({
        heading: 'I18n',
        description: 'Inspect translation lookups and missing translation keys.',
      })
    ),
})

const notificationsEntryType = registerEntryType({
  type: 'notification',
  path: 'notifications',
  label: 'Notifications',
  group: 'Infrastructure',
  icon: Bell,
  load: () =>
    import('@/pages/integration-entry-page').then((module) =>
      module.createIntegrationEntryTypeImplementation({
        heading: 'Notifications',
        description: 'Track notification delivery outcomes through configured adapters.',
      })
    ),
})

const socketsEntryType = registerEntryType({
  type: 'socket',
  path: 'sockets',
  label: 'Sockets',
  group: 'Infrastructure',
  icon: PlugZap,
  load: () =>
    import('@/pages/integration-entry-page').then((module) =>
      module.createIntegrationEntryTypeImplementation({
        heading: 'Sockets',
        description: 'Inspect socket connections, disconnections, and messages.',
      })
    ),
})

export const wave2EntryTypes: readonly EntryTypeRegistration[] = Object.freeze([
  eventsEntryType,
  commandsEntryType,
  mailEntryType,
  cacheEntryType,
  modelsEntryType,
  gatesEntryType,
  viewsEntryType,
  logsEntryType,
  dumpsEntryType,
  httpClientEntryType,
  schedulesEntryType,
  jobsEntryType,
  broadcastsEntryType,
  healthChecksEntryType,
  redisEntryType,
  sessionsEntryType,
  validationsEntryType,
  rateLimitsEntryType,
  locksEntryType,
  driveEntryType,
  allyEntryType,
  i18nEntryType,
  notificationsEntryType,
  socketsEntryType,
])

assertUniqueEntryTypeMetadata(wave2EntryTypes)

const entryTypeLabels: Record<EntryType, string> = {
  request: 'Request',
  query: 'Query',
  exception: 'Exception',
  log: 'Log',
  event: 'Event',
  command: 'Command',
  mail: 'Mail',
  cache: 'Cache',
  model: 'Model',
  gate: 'Gate',
  dump: 'Dump',
  view: 'View',
  http_client: 'HTTP client',
  schedule: 'Schedule',
  job: 'Job',
  broadcast: 'Broadcast',
  health_check: 'Health check',
  redis: 'Redis',
  session: 'Session',
  validation: 'Validation',
  rate_limit: 'Rate limit',
  lock: 'Lock',
  drive: 'Drive',
  ally: 'OAuth (Ally)',
  i18n: 'I18n',
  notification: 'Notification',
  socket: 'Socket',
}

export function getWave2EntryType(type: EntryType): EntryTypeRegistration | undefined {
  return wave2EntryTypes.find((registration) => registration.type === type)
}

export function entryTypeLabel(type: EntryType): string {
  return entryTypeLabels[type]
}
