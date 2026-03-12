import { useState } from 'react'
import { ChevronDown, ChevronRight, Variable } from 'lucide-react'
import type { PromptVariableDeclaration } from '@middleman/protocol'

interface PromptVariablePanelProps {
  variables: PromptVariableDeclaration[]
}

export function PromptVariablePanel({ variables }: PromptVariablePanelProps) {
  const [isOpen, setIsOpen] = useState(true)

  if (variables.length === 0) return null

  return (
    <div className="rounded-md border border-border/70 bg-muted/20">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        {isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <Variable className="size-3.5" />
        <span>Available variables ({variables.length})</span>
      </button>

      {isOpen && (
        <div className="border-t border-border/50 px-3 py-2 space-y-1.5">
          {variables.map((v) => (
            <div key={v.name} className="flex items-baseline gap-2 text-xs">
              <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                {'${' + v.name + '}'}
              </code>
              <span className="text-muted-foreground">{v.description}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
