interface DiffStatusBarProps {
  filesChanged: number
  insertions: number
  deletions: number
}

export function DiffStatusBar({ filesChanged, insertions, deletions }: DiffStatusBarProps) {
  return (
    <div
      className="flex h-7 shrink-0 items-center border-t border-border/60 bg-card/80 px-3 text-xs text-muted-foreground"
      aria-live="polite"
    >
      <span>
        {filesChanged} {filesChanged === 1 ? 'file' : 'files'} changed
      </span>
      {insertions > 0 ? (
        <span className="ml-2 text-emerald-500">
          {insertions} {insertions === 1 ? 'insertion' : 'insertions'}(+)
        </span>
      ) : null}
      {deletions > 0 ? (
        <span className="ml-2 text-red-500">
          {deletions} {deletions === 1 ? 'deletion' : 'deletions'}(-)
        </span>
      ) : null}
      {filesChanged === 0 && insertions === 0 && deletions === 0 ? (
        <span className="ml-1 opacity-60">— nothing to show</span>
      ) : null}
    </div>
  )
}
