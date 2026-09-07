import { useState } from 'react'
import { ChevronLeft, ChevronRight, Flame, X, Zap } from 'lucide-react'
import type { StatsSnapshot } from '@forge/protocol'
import { Button } from '@/components/ui/button'

interface FuckMeterProps {
  data: StatsSnapshot['fuckMeter']
  onClose: () => void
}

const PAGE_SIZE = 30
const formatDay = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, {
  month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
})

export function FuckMeter({ data, onClose }: FuckMeterProps) {
  const [page, setPage] = useState(0)
  const daily = data?.daily ?? []
  const total = daily.reduce((sum, day) => sum + day.count, 0)
  const peak = daily.reduce<(typeof daily)[number] | undefined>((best, day) => !best || day.count > best.count ? day : best, undefined)
  const max = Math.max(1, peak?.count ?? 0)
  const pageCount = Math.max(1, Math.ceil(daily.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount - 1)
  const end = daily.length - currentPage * PAGE_SIZE
  const days = daily.slice(Math.max(0, end - PAGE_SIZE), end)
  const average = daily.length ? total / daily.length : 0
  const mood = total === 0 ? 'Zen mode' : average < 2 ? 'A little spicy' : average < 10 ? 'Running hot' : 'Nuclear vocabulary'

  return (
    <section aria-labelledby="fuck-meter-title" className="relative isolate overflow-hidden rounded-2xl border border-orange-400/30 bg-[#100e18] p-5 text-orange-50 shadow-[0_0_60px_-25px_#f97316] motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3 motion-safe:duration-500 sm:p-7">
      <div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-32 -z-10 size-96 rounded-full bg-orange-600/15 blur-3xl" />
      <div aria-hidden="true" className="pointer-events-none absolute -bottom-48 left-1/4 -z-10 size-96 rounded-full bg-fuchsia-600/15 blur-3xl" />
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.25em] text-orange-300"><Zap className="size-3" /> Classified telemetry · unlocked</p>
          <h2 id="fuck-meter-title" className="text-3xl font-black tracking-tight sm:text-4xl">Fuck Meter<span className="text-orange-400">.</span></h2>
          <p className="mt-1 text-xs text-orange-100/60">Every day has a breaking point. Here’s yours, in words.</p>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Hide Fuck Meter" className="shrink-0 text-orange-100/60 hover:bg-white/10 hover:text-white"><X className="size-4" /></Button>
      </header>

      {!data ? <p className="py-8 text-sm text-orange-100/70">Waiting for the next stats refresh. The fuse is lit.</p> : <>
        <div className="my-7 grid gap-6 sm:grid-cols-[1.2fr_1fr]">
          <div>
            <div className="flex items-baseline gap-3"><span className="bg-gradient-to-br from-amber-200 via-orange-400 to-fuchsia-400 bg-clip-text font-mono text-6xl font-black tracking-tighter text-transparent sm:text-7xl">{total.toLocaleString()}</span><span className="text-xs uppercase tracking-widest text-orange-100/60">fucks given</span></div>
            <p className="mt-2 text-xs text-orange-100/50">Across the selected range · all agent chats</p>
          </div>
          <div className="flex flex-col justify-center rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
            <p className="flex items-center gap-2 text-sm font-semibold text-orange-300"><Flame className="size-4" />{mood}</p>
            <div aria-hidden="true" className="my-3 flex gap-1">{Array.from({ length: 24 }, (_, index) => <span key={index} className="h-3 flex-1 -skew-x-12 rounded-sm" style={{ background: index < Math.min(24, Math.ceil(average * 2)) ? `hsl(${40 - index * 2.5} 95% 60%)` : 'rgba(255,255,255,0.08)' }} />)}</div>
            <div className="flex justify-between gap-3 text-xs text-orange-100/60"><span>{average.toFixed(1)} / day</span><span>Peak: {peak?.count ?? 0}{peak && peak.count > 0 ? ` · ${formatDay(peak.date)}` : ''}</span></div>
          </div>
        </div>

        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-mono text-[10px] uppercase tracking-[0.2em] text-orange-200/70">Daily detonation log</h3>
          {pageCount > 1 && <div className="flex items-center gap-2 text-xs text-orange-100/60">
            <Button variant="ghost" size="icon" aria-label="Earlier Fuck Meter days" disabled={currentPage >= pageCount - 1} onClick={() => setPage(currentPage + 1)}><ChevronLeft className="size-4" /></Button>
            <span>{pageCount - currentPage} / {pageCount}</span>
            <Button variant="ghost" size="icon" aria-label="Later Fuck Meter days" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronRight className="size-4" /></Button>
          </div>}
        </div>
        {total === 0 && <p className="mb-4 text-sm text-orange-100/70">Zero fucks given. A suspicious amount of inner peace.</p>}
        <div className="overflow-x-auto pb-2">
          <div role="list" aria-label="Daily fuck counts" className="flex h-44 items-end gap-1.5 border-b border-orange-200/15 pt-6" style={{ minWidth: days.length * 20 }}>
            {days.map((day) => <div key={day.date} role="listitem" tabIndex={0} title={`${formatDay(day.date)}: ${day.count} fucks`} aria-label={`${formatDay(day.date)}: ${day.count} fucks`} className="group relative flex h-full min-w-3 flex-1 items-end justify-center outline-none">
              <span className="absolute -top-6 z-10 hidden whitespace-nowrap rounded bg-[#302032] px-2 py-1 font-mono text-[10px] text-orange-100 group-hover:block group-focus:block">{day.count}</span>
              <span aria-hidden="true" className="w-full max-w-16 rounded-t-sm bg-gradient-to-t from-fuchsia-600 via-orange-500 to-amber-200 motion-safe:transition-[height] motion-safe:duration-700 group-hover:brightness-125 group-focus:ring-2 group-focus:ring-orange-100" style={{ height: `${Math.max(1.5, day.count / max * 100)}%`, opacity: day.count ? 1 : 0.15, boxShadow: day.count === max ? '0 -5px 22px -6px #fb923c' : undefined }} />
              <span className="sr-only">{formatDay(day.date)}: {day.count}</span>
            </div>)}
          </div>
        </div>
        <div className="mt-1 flex justify-between font-mono text-[10px] text-orange-100/50"><span>{days[0] ? formatDay(days[0].date) : 'No days yet'}</span><span>{days.at(-1) ? formatDay(days.at(-1)!.date) : ''}</span></div>
        <p className="mt-5 border-t border-white/10 pt-3 text-[10px] leading-relaxed text-orange-100/45">Counts “fuck” in all its forms — fucking, fucked, motherfucker… User messages only, never the agents. Calculated with your regular stats, even while hidden.</p>
      </>}
    </section>
  )
}
