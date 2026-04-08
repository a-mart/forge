import { type RefObject, type ChangeEvent, type KeyboardEvent, type ClipboardEvent } from 'react'
import { cn } from '@/lib/utils'
import { renderMentionOverlay } from './mention-utils'

interface ComposerTextareaProps {
  textareaRef: RefObject<HTMLTextAreaElement | null>
  overlayRef: RefObject<HTMLDivElement | null>
  value: string
  placeholder: string
  disabled: boolean
  formatMode: boolean
  hasMentionTokens: boolean
  onChange: (value: string) => void
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void
  onScroll: () => void
  onSelect?: () => void
}

export function ComposerTextarea({
  textareaRef,
  overlayRef,
  value,
  placeholder,
  disabled,
  formatMode,
  hasMentionTokens,
  onChange,
  onKeyDown,
  onPaste,
  onScroll,
  onSelect,
}: ComposerTextareaProps) {
  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    onChange(event.target.value)
  }

  return (
    <div className="relative">
      {hasMentionTokens && (
        <div
          ref={overlayRef}
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-sm leading-normal text-foreground',
            'px-4 pt-3 pb-2',
          )}
        >
          {renderMentionOverlay(value)}
        </div>
      )}
      <textarea
        ref={textareaRef}
        value={value}
        spellCheck
        onChange={handleChange}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onScroll={onScroll}
        onSelect={hasMentionTokens ? onSelect : undefined}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        className={cn(
          'relative w-full resize-none border-0 bg-transparent text-sm leading-normal shadow-none focus:outline-none',
          hasMentionTokens
            ? 'text-transparent placeholder:text-muted-foreground'
            : 'text-foreground',
          formatMode ? 'min-h-[120px]' : 'min-h-[44px]',
          'px-4 pt-3 pb-2',
          '[&::-webkit-scrollbar]:w-1.5',
          '[&::-webkit-scrollbar-track]:bg-transparent',
          '[&::-webkit-scrollbar-thumb]:bg-transparent',
          '[&::-webkit-scrollbar-thumb]:rounded-full',
          'group-hover:[&::-webkit-scrollbar-thumb]:bg-border',
        )}
        style={hasMentionTokens ? { caretColor: 'var(--foreground)' } : undefined}
      />
    </div>
  )
}
