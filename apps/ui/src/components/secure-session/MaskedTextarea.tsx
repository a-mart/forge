import * as React from 'react'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

interface MaskedTextareaProps extends Omit<
  React.ComponentProps<'textarea'>,
  'onBeforeInput' | 'onChange' | 'onPaste' | 'value'
> {
  value: string
  onValueChange: (value: string) => void
}

const MASK_CHARACTER = '•'

const MaskedTextarea = React.forwardRef<HTMLTextAreaElement, MaskedTextareaProps>(
  ({ className, onKeyDown, onValueChange, style, value, ...props }, ref) => {
    const textareaRef = React.useRef<HTMLTextAreaElement>(null)
    const rawValueRef = React.useRef(value)

    React.useImperativeHandle(ref, () => textareaRef.current!, [])
    React.useLayoutEffect(() => {
      rawValueRef.current = value
      const textarea = textareaRef.current
      const nextDisplayValue = maskedDisplayValue(value)
      if (textarea && textarea.value !== nextDisplayValue) {
        textarea.value = nextDisplayValue
      }
    }, [value])

    const setRawValue = (nextValue: string, rawSelectionStart?: number) => {
      rawValueRef.current = nextValue
      const textarea = textareaRef.current
      if (textarea) textarea.value = maskedDisplayValue(nextValue)
      onValueChange(nextValue)

      if (textarea && rawSelectionStart !== undefined) {
        const nextSelection = displayOffsetForRawOffset(nextValue, rawSelectionStart)
        requestAnimationFrame(() => textarea.setSelectionRange(nextSelection, nextSelection))
      }
    }

    const replaceSelection = (replacement: string, rawStart?: number, rawEnd?: number) => {
      const textarea = textareaRef.current
      const rawValue = rawValueRef.current
      const start = rawStart ?? rawOffsetForDisplayOffset(rawValue, textarea?.selectionStart ?? 0)
      const end = rawEnd ?? rawOffsetForDisplayOffset(rawValue, textarea?.selectionEnd ?? 0)
      const nextValue = `${rawValue.slice(0, start)}${replacement}${rawValue.slice(end)}`
      setRawValue(nextValue, start + replacement.length)
    }

    const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      onKeyDown?.(event)
      if (
        event.defaultPrevented
        || event.nativeEvent.isComposing
        || event.altKey
        || event.ctrlKey
        || event.metaKey
      ) {
        return
      }

      const textarea = event.currentTarget
      const rawValue = rawValueRef.current
      const selectionStart = rawOffsetForDisplayOffset(rawValue, textarea.selectionStart)
      const selectionEnd = rawOffsetForDisplayOffset(rawValue, textarea.selectionEnd)

      if (event.key === 'Backspace') {
        event.preventDefault()
        const start = selectionStart === selectionEnd
          ? rawOffsetForDisplayOffset(rawValue, Math.max(0, textarea.selectionStart - 1))
          : selectionStart
        replaceSelection('', start, selectionEnd)
        return
      }

      if (event.key === 'Delete') {
        event.preventDefault()
        const end = selectionStart === selectionEnd
          ? rawOffsetForDisplayOffset(rawValue, textarea.selectionEnd + 1)
          : selectionEnd
        replaceSelection('', selectionStart, end)
        return
      }

      if (event.key === 'Enter') {
        event.preventDefault()
        replaceSelection('\n', selectionStart, selectionEnd)
        return
      }

      if (Array.from(event.key).length === 1 && event.key !== 'Dead') {
        event.preventDefault()
        replaceSelection(event.key, selectionStart, selectionEnd)
      }
    }

    const handleBeforeInput = (event: React.FormEvent<HTMLTextAreaElement>) => {
      const input = event.nativeEvent as InputEvent
      const textarea = event.currentTarget
      const rawValue = rawValueRef.current
      const selectionStart = rawOffsetForDisplayOffset(rawValue, textarea.selectionStart)
      const selectionEnd = rawOffsetForDisplayOffset(rawValue, textarea.selectionEnd)
      const inputType = input.inputType

      if (inputType === 'insertLineBreak' || inputType === 'insertParagraph') {
        event.preventDefault()
        replaceSelection(input.data ?? '\n', selectionStart, selectionEnd)
        return
      }

      if (inputType.startsWith('insert') && input.data !== null) {
        event.preventDefault()
        replaceSelection(input.data, selectionStart, selectionEnd)
        return
      }

      if (inputType === 'deleteContentBackward') {
        event.preventDefault()
        const start = selectionStart === selectionEnd
          ? rawOffsetForDisplayOffset(rawValue, Math.max(0, textarea.selectionStart - 1))
          : selectionStart
        replaceSelection('', start, selectionEnd)
        return
      }

      if (inputType === 'deleteContentForward') {
        event.preventDefault()
        const end = selectionStart === selectionEnd
          ? rawOffsetForDisplayOffset(rawValue, textarea.selectionEnd + 1)
          : selectionEnd
        replaceSelection('', selectionStart, end)
      }
    }

    const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      // beforeinput handles normal browser edits without ever writing plaintext
      // into the control. This is a defensive fallback for browser features that
      // do not provide beforeinput (such as some autofill and test environments).
      const rawValue = rawValueRef.current
      setRawValue(replaceDisplayRange(rawValue, event.currentTarget.value))
    }

    const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const pastedValue = event.clipboardData?.getData('text/plain')
      if (pastedValue === undefined) return

      event.preventDefault()
      replaceSelection(pastedValue)
    }

    return (
      <Textarea
        {...props}
        ref={textareaRef}
        data-slot="masked-textarea"
        value={maskedDisplayValue(value)}
        onKeyDown={handleKeyDown}
        onBeforeInput={handleBeforeInput}
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

function maskedDisplayValue(value: string): string {
  let maskedValue = ''
  for (let offset = 0; offset < value.length; offset += rawCharacterLengthAt(value, offset)) {
    maskedValue += value[offset] === '\r' || value[offset] === '\n'
      ? '\n'
      : MASK_CHARACTER
  }
  return maskedValue
}

function rawCharacterLengthAt(value: string, offset: number): number {
  if (value[offset] === '\r' && value[offset + 1] === '\n') return 2
  const codePoint = value.codePointAt(offset)
  return codePoint !== undefined && codePoint > 0xffff ? 2 : 1
}

function replaceDisplayRange(rawValue: string, nextDisplayValue: string): string {
  const currentDisplayValue = maskedDisplayValue(rawValue)
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
    rawOffset += rawCharacterLengthAt(value, rawOffset)
    currentDisplayOffset += 1
  }
  return rawOffset
}

function displayOffsetForRawOffset(value: string, rawOffset: number): number {
  let displayOffset = 0
  for (let offset = 0; offset < rawOffset && offset < value.length; offset += rawCharacterLengthAt(value, offset)) {
    displayOffset += 1
  }
  return displayOffset
}

export { MaskedTextarea }
