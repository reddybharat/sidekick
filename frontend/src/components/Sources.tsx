import { cn } from 'cn'
import type { Turn } from '@/components/Chat'
import type { LibraryDocument } from '@/lib/api'
import { parseCitations } from '@/lib/citations'

// Up to NUMBERED_PAGES each page is a numbered tile; up to MAX_PAGE_STRIP a thin tick; beyond that only the cited page numbers.
const NUMBERED_PAGES = 12
const MAX_PAGE_STRIP = 60

interface Cited {
  pages: Set<number>
  count: number
}

interface Props {
  turns: Turn[]
  documents: LibraryDocument[]
}

export function Sources({ turns, documents }: Props) {
  const cited = new Map<string, Cited>()
  for (const t of turns) {
    if (t.role !== 'assistant') continue
    for (const c of parseCitations(t.text)) {
      const entry = cited.get(c.filename) ?? { pages: new Set<number>(), count: 0 }
      for (const p of c.pages) entry.pages.add(p)
      entry.count += 1
      cited.set(c.filename, entry)
    }
  }
  const pageCounts = new Map(documents.map((d) => [d.filename, d.page_count]))
  const uncited = documents.filter((d) => d.status === 'ready' && !cited.has(d.filename))

  return (
    <aside className="flex min-w-0 flex-col border-l" aria-label="Sources">
      <div className="flex h-13 shrink-0 items-center gap-3 border-b px-5">
        <h2 className="text-[15px] font-semibold">Sources</h2>
        <span className="text-[13px] text-muted-foreground">cited in this session</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4.5">
        {cited.size === 0 && (
          <p className="text-sm text-muted-foreground">
            No citations yet. Pages appear here as answers cite them.
          </p>
        )}
        {[...cited].map(([filename, c]) => (
          <Source key={filename} filename={filename} pageCount={pageCounts.get(filename) ?? null} cited={c} />
        ))}
        {uncited.length > 0 && (
          <div className="flex flex-col gap-1.5 border-t pt-4">
            <span className="text-xs font-semibold text-muted-foreground">Also in your library</span>
            {uncited.map((d) => (
              <div key={d.id} className="flex items-baseline justify-between gap-2 text-[13px]">
                <span className="truncate" title={d.filename}>
                  {d.filename}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {d.page_count ?? '—'} pp.
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="border-t px-5 py-3.5 text-xs text-muted-foreground">
        Every question searches all ready documents in your library.
      </p>
    </aside>
  )
}

function Source({
  filename,
  pageCount,
  cited,
}: {
  filename: string
  pageCount: number | null
  cited: Cited
}) {
  const pages = [...cited.pages].sort((a, b) => a - b)
  const strip = pageCount !== null && pageCount <= MAX_PAGE_STRIP
  const numbered = strip && pageCount <= NUMBERED_PAGES
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm font-semibold" title={filename}>
          {filename}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {pageCount === null ? 'not in library' : `${pageCount} pages`}
        </span>
      </div>
      {strip && (
        <div
          className="flex flex-wrap gap-0.75"
          role="img"
          aria-label={`${pageCount} pages${pages.length ? `, cited: ${pages.join(', ')}` : ''}`}
        >
          {Array.from({ length: pageCount }, (_, i) => i + 1).map((p) => (
            <span
              key={p}
              className={cn(
                'border border-input bg-card text-[10px] text-muted-foreground tabular-nums',
                numbered ? 'flex h-7 w-5.5 items-end justify-center pb-0.5' : 'h-5.5 w-2.25',
                cited.pages.has(p) && 'border-primary bg-primary font-semibold text-primary-foreground',
              )}
            >
              {numbered && p}
            </span>
          ))}
        </div>
      )}
      <p className="text-[12.5px] text-muted-foreground tabular-nums">
        Cited {cited.count} {cited.count === 1 ? 'time' : 'times'} ·{' '}
        {pages.length === 1 ? 'p.' : 'pp.'} {pages.join(', ')}
      </p>
    </div>
  )
}
