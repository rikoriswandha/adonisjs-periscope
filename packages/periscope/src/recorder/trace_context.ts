import { createRequire } from 'node:module'

type OpenTelemetryApi = {
  context: { active(): unknown }
  trace: {
    getSpan(context: unknown): { spanContext(): { traceId?: unknown } } | undefined
  }
}

const require = createRequire(import.meta.url)
let api: OpenTelemetryApi | null | undefined

function resolveApi(): OpenTelemetryApi | null {
  if (api !== undefined) return api

  try {
    api = require('@opentelemetry/api') as OpenTelemetryApi
  } catch {
    api = null
  }

  return api
}

/** Read the active span without making OpenTelemetry a required runtime dependency. */
export function activeTraceId(): string | undefined {
  try {
    const otel = resolveApi()
    const traceId = otel?.trace.getSpan(otel.context.active())?.spanContext().traceId

    if (
      typeof traceId === 'string' &&
      /^[a-f\d]{32}$/i.test(traceId) &&
      traceId !== '00000000000000000000000000000000'
    ) {
      return traceId.toLowerCase()
    }
  } catch {
    // Observability context must never interfere with opening the host application's batch.
  }

  return undefined
}
