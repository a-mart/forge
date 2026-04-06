import type { FrontMatterResult } from '@/lib/parse-front-matter'

/**
 * Collapsible display block for YAML front matter metadata.
 *
 * Renders as a collapsed `<details>` by default, showing field count
 * in the summary and a key-value grid when expanded.
 */
export function FrontMatterBlock({ entries }: { entries: FrontMatterResult['entries'] }) {
  return (
    <details className="mb-4 rounded-md border border-border/40 bg-muted/30">
      <summary className="cursor-pointer select-none px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground/80">
        Front Matter
        <span className="ml-1.5 text-muted-foreground/50">
          ({entries.length} {entries.length === 1 ? 'field' : 'fields'})
        </span>
      </summary>
      <div className="border-t border-border/30 px-4 py-2">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {entries.map(({ key, value }, idx) => (
            <div key={`${key}-${idx}`} className="col-span-2 grid grid-cols-subgrid">
              <dt className="py-0.5 font-medium text-muted-foreground/70">{key}</dt>
              <dd className="truncate py-0.5 font-mono text-foreground/70" title={value}>
                {value || <span className="italic text-muted-foreground/40">empty</span>}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </details>
  )
}
