import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import type { Signal } from '@/components/instrument'
import { SIGNAL_BG } from '@/components/instrument'
import { useDashboard } from '@/dashboard-context'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { EntryType } from '@/types'

/**
 * The signal strip.
 *
 * A permanent, always-on readout of what the application has actually been
 * doing, pinned under the top bar on every screen. It is the one piece of
 * chrome that is unmistakably *periscope*: you do not navigate to it, it is
 * simply always watching the surface.
 *
 * It is built from real recorded entries — `StoredEntry.createdAt` for the time
 * axis, entry type and HTTP status for the signal — and it stays current by
 * consuming the same SSE flush stream the rest of the dashboard uses. Clicking
 * a bucket filters the requests index to that exact window via the `from`/`to`
 * params the API already supports, so it is a navigation control, not decoration.
 */

const BUCKET_COUNT = 96
/** How often the trailing edge of the window advances while idle. */
const CLOCK_TICK_MS = 15_000
const SAMPLE_SIZE = 400
/** Below this the strip would be a row of hairlines; it reports "no signal" instead. */
const MIN_SAMPLES = 2

type Sample = { at: number; signal: Signal }
type Bucket = { count: number; signal: Signal; from: number; to: number }

const SIGNAL_RANK: Record<Signal, number> = { neutral: 0, ok: 1, info: 2, warn: 3, error: 4 }

/**
 * Reduces an entry to the one thing the strip reports: did this look like
 * trouble. Exceptions always do; requests inherit their status class.
 */
function sampleSignal(type: EntryType, content: Record<string, unknown>): Signal {
  if (type === 'exception') return 'error'
  if (type === 'health_check') {
    const status = content.status
    if (status === 'error') return 'error'
    if (status === 'warning') return 'warn'
    return 'ok'
  }
  const status = typeof content.status === 'number' ? content.status : undefined
  if (status === undefined) return 'ok'
  if (status >= 500) return 'error'
  if (status >= 400) return 'warn'
  return 'ok'
}



export function SignalStrip({ className }: { className?: string }) {
  const navigate = useNavigate()
  const { selectedApplication, flushEvent, flushRevision, revision, status } = useDashboard()
  const [samples, setSamples] = useState<Sample[]>([])
  const [ready, setReady] = useState(false)
  const [hovered, setHovered] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const generationRef = useRef(0)

  /*
    The window's trailing edge advances on a timer rather than being read
    during render: reading the clock while rendering is impure and makes the
    bucket layout depend on when React happens to re-render.
  */
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    const generation = ++generationRef.current
    const controller = new AbortController()
    setReady(false)

    api
      .listEntries({ application: selectedApplication, limit: SAMPLE_SIZE }, controller.signal)
      .then((page) => {
        if (generation !== generationRef.current) return
        setSamples(page.data
                  .map((entry) => ({
                    at: new Date(entry.createdAt).getTime(),
                    signal: sampleSignal(entry.type, entry.content ?? {}),
                  }))
                  .sort((a, b) => a.at - b.at))
        setReady(true)
      })
      .catch(() => {
        if (generation !== generationRef.current) return
        // A failed sample is not worth an error surface; the strip simply
        // reports no signal and the dashboard's own error banner takes over.
        setSamples([])
        setReady(true)
      })

    return () => controller.abort()
  }, [selectedApplication, revision])

  /** Live rows arrive on the same stream the index tables tail. */
  useEffect(() => {
    if (!flushEvent) return
    const row = flushEvent.indexRow
    setSamples((current) => {
      const next = [...current, { at: new Date(row.createdAt).getTime(), signal: 'ok' as Signal }]
      return next.length > SAMPLE_SIZE ? next.slice(next.length - SAMPLE_SIZE) : next
    })
    // The stream carries index rows without content, so severity is refined by
    // the next full sample rather than guessed at here.
  }, [flushEvent, flushRevision])

  const { buckets, start, end, max } = useMemo(() => {
    if (samples.length < MIN_SAMPLES) {
      return { buckets: [] as Bucket[], start: 0, end: 0, max: 0 }
    }

    const first = samples[0].at
    const last = Math.max(samples[samples.length - 1].at, now)
    const span = Math.max(last - first, 1)
    const width = span / BUCKET_COUNT

    const list: Bucket[] = Array.from({ length: BUCKET_COUNT }, (_, index) => ({
      count: 0,
      signal: 'neutral',
      from: first + index * width,
      to: first + (index + 1) * width,
    }))

    for (const sample of samples) {
      const index = Math.min(BUCKET_COUNT - 1, Math.floor((sample.at - first) / width))
      const bucket = list[index]
      bucket.count += 1
      if (SIGNAL_RANK[sample.signal] > SIGNAL_RANK[bucket.signal]) bucket.signal = sample.signal
    }

    return {
      buckets: list,
      start: first,
      end: last,
      max: list.reduce((highest, bucket) => Math.max(highest, bucket.count), 0),
    }
  }, [samples, now])

  const openBucket = useCallback(
    (bucket: Bucket) => {
      const params = new URLSearchParams({
        application: selectedApplication,
        from: new Date(bucket.from).toISOString(),
        to: new Date(bucket.to).toISOString(),
      })
      navigate(`/requests?${params.toString()}`)
    },
    [navigate, selectedApplication]
  )

  const timeFormat = useMemo(
    () => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }),
    []
  )
  const stampFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
    []
  )

  const active = hovered === null ? null : buckets[hovered]
  const total = samples.length
  const errors = useMemo(
    () => samples.reduce((count, sample) => (sample.signal === 'error' ? count + 1 : count), 0),
    [samples]
  )

  return (
    <div
      className={cn(
        'relative flex h-9 shrink-0 items-stretch gap-3 border-b border-edge bg-chassis px-3',
        className
      )}
    >
      <div className="flex shrink-0 items-center gap-2 py-1">
        <span className="micro-label">Activity</span>
        <span className="num text-micro text-ink-4">
          {ready ? `${total.toLocaleString()} sampled` : '—'}
        </span>
      </div>

      {!ready ? (
        <div className="flex flex-1 items-end gap-px py-1.5" aria-hidden="true">
          {Array.from({ length: 48 }, (_, index) => (
            <span
              className="h-1 flex-1 rounded-[1px] bg-edge/60 animate-skeleton"
              key={index}
              style={{ animationDelay: `${index * 12}ms` }}
            />
          ))}
        </div>
      ) : buckets.length === 0 ? (
        <div className="flex flex-1 items-center">
          <span className="text-micro text-ink-4">
            No recorded activity yet — this fills in as your application handles traffic.
          </span>
        </div>
      ) : (
        <>
          <div
            aria-label={`Recent activity: ${total} entries, ${errors} errors, between ${stampFormat.format(start)} and ${stampFormat.format(end)}`}
            className="group/strip relative flex flex-1 items-end gap-px py-1.5"
            onMouseLeave={() => setHovered(null)}
            role="img"
          >
            {buckets.map((bucket, index) => {
              /* Square-root scaling keeps a single stray entry visible next to a
                 burst, which linear scaling would flatten to nothing. */
              const ratio = max > 0 ? Math.sqrt(bucket.count / max) : 0
              const empty = bucket.count === 0
              return (
                <button
                  aria-label={`${bucket.count} entries around ${stampFormat.format(bucket.from)}`}
                  className={cn(
                    'relative flex h-full flex-1 cursor-pointer items-end rounded-[1px]',
                    'transition-opacity duration-(--dur-fast) ease-(--ease-out-quart)',
                    'focus-visible:outline-1 focus-visible:outline-offset-0',
                    hovered !== null && hovered !== index && 'opacity-45'
                  )}
                  disabled={empty}
                  key={index}
                  onClick={() => openBucket(bucket)}
                  onFocus={() => setHovered(index)}
                  onMouseEnter={() => setHovered(index)}
                  type="button"
                >
                  <span
                    className={cn(
                      'block w-full rounded-[1px]',
                      empty ? 'bg-edge/70' : SIGNAL_BG[bucket.signal]
                    )}
                    style={{ height: empty ? '2px' : `${Math.max(12, ratio * 100)}%` }}
                  />
                </button>
              )
            })}
          </div>

          <div className="flex shrink-0 items-center gap-2 py-1">
            {active && active.count > 0 ? (
              <span className="num text-micro text-ink-2" role="status">
                {active.count.toLocaleString()} @ {stampFormat.format(active.from)}
              </span>
            ) : (
              <span className="num text-micro text-ink-4">
                {timeFormat.format(start)} → {timeFormat.format(end)}
              </span>
            )}
            {errors > 0 && (
              <span className="num inline-flex items-center gap-1 text-micro text-sig-error">
                <span className={cn('size-[5px] rounded-full', SIGNAL_BG.error)} />
                {errors.toLocaleString()}
              </span>
            )}
            {status?.paused && (
              <span className="micro-label text-sig-warn" title="Recording is paused">
                Paused
              </span>
            )}
          </div>
        </>
      )}
    </div>
  )
}
