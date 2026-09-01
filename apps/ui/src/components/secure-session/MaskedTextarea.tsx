import * as React from 'react'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

interface MaskedTextareaProps extends Omit<
  React.ComponentProps<'textarea'>,
  'onChange' | 'onPaste' | 'value'
> {
  value: string
  onValueChange: (value: string) => void
}

const MaskedTextarea = React.forwardRef<HTMLTextAreaElement, MaskedTextareaProps>(
  ({ className, onValueChange, style, value, ...props }, ref) => {
    const textareaRef = React.useRef<HTMLTextAreaElement>(null)

    React.useImperativeHandle(ref, () => textareaRef.current!, [])
    React.useLayoutEffect(() => {
      const textarea = textareaRef.current
      const nextDisplayValue = displayValue(value)
      if (textarea && textarea.value !== nextDisplayValue) {
        textarea.value = nextDisplayValue
      }
    }, [value])

    const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      onValueChange(replaceDisplayRange(value, event.currentTarget.value))
    }

    const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const pastedValue = event.clipboardData?.getData('text/plain')
      if (pastedValue === undefined) return

      event.preventDefault()
      const textarea = event.currentTarget
      const start = rawOffsetForDisplayOffset(value, textarea.selectionStart)
      const end = rawOffsetForDisplayOffset(value, textarea.selectionEnd)
      const nextValue = `${value.slice(0, start)}${pastedValue}${value.slice(end)}`
      const nextSelection = displayOffsetForRawOffset(nextValue, start + pastedValue.length)
      textarea.value = displayValue(nextValue)
      onValueChange(nextValue)
      requestAnimationFrame(() => textarea.setSelectionRange(nextSelection, nextSelection))
    }

    return (
      <Textarea
        {...props}
        ref={textareaRef}
        data-slot="masked-textarea"
        onChange={handleChange}
        onPaste={handlePaste}
        style={style}
        className={cn(
          'field-sizing-fixed min-h-24 max-h-48 resize-y [-webkit-text-security:disc]',
          className,
        )}
      />
    )
  },
)
MaskedTextarea.displayName = 'MaskedTextarea'

function displayValue(value: string): string {
  return value.replace(/\r\n?|\n/g, '\n')
}

function replaceDisplayRange(rawValue: string, nextDisplayValue: string): string {
  const currentDisplayValue = displayValue(rawValue)
  let prefixLength = 0
  while (
    prefixLength < currentDisplayValue.length
    && prefixLength < nextDisplayValue.length
    && currentDisplayValue[prefixLength] === nextDisplayValue[prefixLength]
  ) {
    prefixLength += 1
  }

  let currentSuffixLength = currentDisplayValue.length
  let nextSuffixLength = nextDisplayValue.length
  while (
    currentSuffixLength > prefixLength
    && nextSuffixLength > prefixLength
    && currentDisplayValue[currentSuffixLength - 1] === nextDisplayValue[nextSuffixLength - 1]
  ) {
    currentSuffixLength -= 1
    nextSuffixLength -= 1
  }

  const rawStart = rawOffsetForDisplayOffset(rawValue, prefixLength)
  const rawEnd = rawOffsetForDisplayOffset(rawValue, currentSuffixLength)
  return `${rawValue.slice(0, rawStart)}${nextDisplayValue.slice(prefixLength, nextSuffixLength)}${rawValue.slice(rawEnd)}`
}

function rawOffsetForDisplayOffset(value: string, displayOffset: number): number {
  let rawOffset = 0
  let currentDisplayOffset = 0
  while (rawOffset < value.length && currentDisplayOffset < displayOffset) {
    if (value[rawOffset] === '\r' && value[rawOffset + 1] === '\n') {
      rawOffset += 2
    } else {
      rawOffset += 1
    }
    currentDisplayOffset += 1
  }
  return rawOffset
}

function displayOffsetForRawOffset(value: string, rawOffset: number): number {
  return displayValue(value.slice(0, rawOffset)).length
}

export { MaskedTextarea }
