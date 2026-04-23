import { forwardRef, useCallback, useImperativeHandle, type KeyboardEvent } from 'react'
import { ALargeSmall, ArrowUp, List, ListOrdered, Loader2, Mic, Paperclip, Square } from 'lucide-react'
import { AttachedFiles } from '@/components/chat/AttachedFiles'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { findMentionContaining } from './message-input/mention-utils'
import { toggleBulletList, toggleNumberedList } from './message-input/format-utils'
import { SlashCommandMenu } from './message-input/SlashCommandMenu'
import { MentionMenu } from './message-input/MentionMenu'
import { VoiceRecordingBar } from './message-input/VoiceRecordingBar'
import { ComposerTextarea } from './message-input/ComposerTextarea'
import { useDraft } from './message-input/hooks/use-draft'
import { useSlashCommands } from './message-input/hooks/use-slash-commands'
import { useMentions } from './message-input/hooks/use-mentions'
import { useVoiceInput } from './message-input/hooks/use-voice-input'
import { useAttachments } from './message-input/hooks/use-attachments'
import { useComposer } from './message-input/hooks/use-composer'

// Re-export public types for external consumers
export type { ProjectAgentSuggestion, MessageInputHandle, MessageInputProps } from './message-input/types'
import type { MessageInputHandle, MessageInputProps } from './message-input/types'

export const MessageInput = forwardRef<MessageInputHandle, MessageInputProps>(function MessageInput(
  {
    onSend,
    onSubmitted,
    isLoading,
    disabled = false,
    placeholderOverride,
    agentLabel = 'agent',
    allowWhileLoading = false,
    wsUrl,
    agentId,
    draftKey,
    slashCommands,
    projectAgents,
  },
  ref,
) {
  const blockedByLoading = isLoading && !allowWhileLoading

  // --- Draft persistence ---
  const {
    input,
    setInputWithDraft,
    attachedFiles,
    setAttachedFilesWithDraft,
    inputRef,
    attachedFilesRef,
  } = useDraft({ draftKey: draftKey ?? agentId })

  // --- Voice input ---
  const appendTranscription = useCallback(
    (transcribedText: string): boolean => {
      const trimmedText = transcribedText.trim()
      if (!trimmedText) return false

      const previousInput = inputRef.current
      let next: string
      if (!previousInput.trim()) {
        next = trimmedText
      } else {
        const separator = previousInput.endsWith('\n') || previousInput.endsWith(' ') ? '' : '\n'
        next = `${previousInput}${separator}${trimmedText}`
      }

      setInputWithDraft(next)
      return true
    },
    [inputRef, setInputWithDraft],
  )

  const voice = useVoiceInput({
    wsUrl,
    disabled,
    blockedByLoading,
    onTranscription: appendTranscription,
  })

  const isRecording = voice.isRecording
  const isTranscribingVoice = voice.isTranscribingVoice

  // --- Composer (textarea, format mode, submit) ---
  const {
    textareaRef,
    overlayRef,
    fileInputRef,
    formatMode,
    toggleFormatMode,
    applyListFormatting,
    submitMessage,
    handleSubmit,
    syncOverlayScroll,
    canSubmit,
    restoreLastSubmission,
  } = useComposer({
    input,
    attachedFiles,
    disabled,
    blockedByLoading,
    isRecording,
    isTranscribingVoice,
    onSend,
    onSubmitted,
    setInputWithDraft,
    setAttachedFilesWithDraft,
  })

  // --- Slash commands ---
  const slash = useSlashCommands({
    slashCommands,
    setInputWithDraft,
    textareaRef,
  })

  // --- Mentions ---
  const mentions = useMentions({
    projectAgents,
    input,
    setInputWithDraft,
    textareaRef,
  })

  // --- Attachments ---
  const attachments = useAttachments({
    disabled,
    isRecording,
    attachedFilesRef,
    setAttachedFilesWithDraft,
    textareaRef,
  })

  // --- Imperative ref ---
  useImperativeHandle(
    ref,
    () => ({
      setInput: (value: string) => {
        setInputWithDraft(value)
        requestAnimationFrame(() => textareaRef.current?.focus())
      },
      focus: () => {
        textareaRef.current?.focus()
      },
      addFiles: attachments.addFiles,
      addTerminalContext: attachments.addTerminalContext,
      restoreLastSubmission,
    }),
    [attachments.addFiles, attachments.addTerminalContext, restoreLastSubmission, setInputWithDraft, textareaRef],
  )

  // --- Mention cursor snap ---
  const snapCursorOutOfMention = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    const { selectionStart, selectionEnd } = textarea
    if (selectionStart !== selectionEnd) return
    const mention = findMentionContaining(input, selectionStart)
    if (mention && selectionStart > mention.start && selectionStart < mention.end) {
      const snapTo =
        selectionStart - mention.start <= mention.end - selectionStart
          ? mention.start
          : mention.end
      textarea.setSelectionRange(snapTo, snapTo)
    }
  }, [input, textareaRef])

  // --- Input change handler ---
  const handleInputChange = useCallback(
    (value: string) => {
      setInputWithDraft(value)

      // Check slash trigger first
      if (slash.checkSlashTrigger(value)) {
        mentions.setIsMentionMenuOpen(false)
        return
      }

      // Then check mention trigger
      mentions.checkMentionTrigger(value)
    },
    [setInputWithDraft, slash, mentions],
  )

  // --- Keyboard handler ---
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // @mention autocomplete keyboard handling
    if (mentions.isMentionMenuOpen && mentions.filteredMentions.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        mentions.setMentionSelectedIndex(
          (mentions.mentionSelectedIndex + 1) % mentions.filteredMentions.length,
        )
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        mentions.setMentionSelectedIndex(
          (mentions.mentionSelectedIndex - 1 + mentions.filteredMentions.length) %
            mentions.filteredMentions.length,
        )
        return
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault()
        const selected = mentions.filteredMentions[mentions.mentionSelectedIndex]
        if (selected) mentions.selectMention(selected)
        return
      }
    }
    if (mentions.isMentionMenuOpen && event.key === 'Escape') {
      event.preventDefault()
      mentions.setIsMentionMenuOpen(false)
      return
    }

    // Atomic backspace/delete for mention tokens
    if (mentions.hasMentionTokens && (event.key === 'Backspace' || event.key === 'Delete')) {
      const textarea = textareaRef.current
      if (textarea && textarea.selectionStart === textarea.selectionEnd) {
        const pos = textarea.selectionStart
        const mention = findMentionContaining(input, pos)
        if (mention) {
          const shouldDelete =
            event.key === 'Backspace' ? pos > mention.start : pos < mention.end
          if (shouldDelete) {
            event.preventDefault()
            const newValue = input.slice(0, mention.start) + input.slice(mention.end)
            setInputWithDraft(newValue)
            requestAnimationFrame(() => {
              textarea.setSelectionRange(mention.start, mention.start)
            })
            return
          }
        }
      }
    }

    // Slash command autocomplete keyboard handling
    if (slash.isSlashMenuOpen && slash.filteredSlashCommands.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        slash.setSlashSelectedIndex(
          (slash.slashSelectedIndex + 1) % slash.filteredSlashCommands.length,
        )
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        slash.setSlashSelectedIndex(
          (slash.slashSelectedIndex - 1 + slash.filteredSlashCommands.length) %
            slash.filteredSlashCommands.length,
        )
        return
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault()
        const selected = slash.filteredSlashCommands[slash.slashSelectedIndex]
        if (selected) slash.selectSlashCommand(selected)
        return
      }
    }
    if (slash.isSlashMenuOpen && event.key === 'Escape') {
      event.preventDefault()
      slash.setIsSlashMenuOpen(false)
      return
    }

    // Toggle format mode: Shift+Cmd+X (Mac) / Shift+Ctrl+X (Windows/Linux)
    if (event.key.toLowerCase() === 'x' && event.shiftKey && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      toggleFormatMode()
      return
    }

    if (formatMode) {
      // Format mode: Enter inserts newline (default), Ctrl/Cmd+Enter sends
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        submitMessage()
      }
    } else {
      // Quick-send mode: Enter sends, Shift+Enter inserts newline
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        submitMessage()
      }
    }
  }

  const placeholder = placeholderOverride ?? (
    disabled
      ? 'Waiting for connection...'
      : allowWhileLoading && isLoading
        ? `Send another message to ${agentLabel}...`
        : `Message ${agentLabel}...`
  )

  return (
    <form onSubmit={handleSubmit} className="sticky bottom-0 shrink-0 bg-background p-2 md:p-3" data-tour="chat-input">
      {/* Slash command autocomplete dropdown */}
      {slash.isSlashMenuOpen ? (
        <SlashCommandMenu
          menuRef={slash.slashMenuRef}
          commands={slash.filteredSlashCommands}
          selectedIndex={slash.slashSelectedIndex}
          onSelect={slash.selectSlashCommand}
          onHover={slash.setSlashSelectedIndex}
          showEmpty={!!(slashCommands && slashCommands.length > 0 && slash.filteredSlashCommands.length === 0)}
        />
      ) : null}

      {/* @mention autocomplete dropdown */}
      {mentions.isMentionMenuOpen ? (
        <MentionMenu
          menuRef={mentions.mentionMenuRef}
          mentions={mentions.filteredMentions}
          selectedIndex={mentions.mentionSelectedIndex}
          onSelect={mentions.selectMention}
          onHover={mentions.setMentionSelectedIndex}
          showEmpty={!!(projectAgents && projectAgents.length > 0 && mentions.filteredMentions.length === 0)}
        />
      ) : null}

      <div className="overflow-hidden rounded-2xl border border-border">
        <AttachedFiles attachments={attachedFiles} onRemove={attachments.removeAttachment} />

        <div className="group flex flex-col">
          {formatMode && !isRecording ? (
            <div className="flex items-center gap-0.5 border-b border-border/40 px-2 py-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 rounded-md text-muted-foreground hover:text-foreground"
                onClick={() => applyListFormatting(toggleBulletList)}
                disabled={disabled}
                aria-label="Bullet list"
              >
                <List className="size-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 rounded-md text-muted-foreground hover:text-foreground"
                onClick={() => applyListFormatting(toggleNumberedList)}
                disabled={disabled}
                aria-label="Numbered list"
              >
                <ListOrdered className="size-3.5" />
              </Button>
            </div>
          ) : null}

          {isRecording ? (
            <VoiceRecordingBar
              durationMs={voice.voiceRecordingDurationMs}
              waveformBars={voice.recordingWaveformBars}
              onStop={() => void voice.stopAndTranscribeRecording()}
              disabled={voice.voiceButtonDisabled}
            />
          ) : (
            <ComposerTextarea
              textareaRef={textareaRef}
              overlayRef={overlayRef}
              value={input}
              placeholder={placeholder}
              disabled={disabled}
              formatMode={formatMode}
              hasMentionTokens={mentions.hasMentionTokens}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onPaste={attachments.handlePaste}
              onScroll={syncOverlayScroll}
              onSelect={mentions.hasMentionTokens ? snapCursorOutOfMention : undefined}
            />
          )}

          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={attachments.handleFileSelect}
            aria-label="Attach files"
          />

          <div className="flex items-center justify-between px-1.5 pb-1.5 pt-1">
            <div className="flex items-center gap-0.5">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  'size-7 rounded-full transition-colors',
                  formatMode
                    ? 'bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary'
                    : 'text-muted-foreground/60 hover:text-foreground',
                )}
                onClick={toggleFormatMode}
                disabled={disabled || isRecording}
                aria-label={formatMode ? 'Switch to quick-send mode' : 'Switch to format mode'}
                title={formatMode ? 'Quick-send mode (Enter to send)' : 'Format mode (Enter for new line)'}
              >
                <ALargeSmall className="size-3.5" />
              </Button>

              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 rounded-full text-muted-foreground/60 hover:text-foreground"
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled || isRecording}
                aria-label="Attach files"
              >
                <Paperclip className="size-3.5" />
              </Button>

              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  'size-7 rounded-full transition-colors',
                  isRecording
                    ? 'text-red-500 hover:bg-red-500/10 hover:text-red-600'
                    : 'text-muted-foreground/60 hover:text-foreground',
                )}
                onClick={voice.handleVoiceButtonClick}
                disabled={voice.voiceButtonDisabled}
                aria-label={isRecording ? 'Stop recording and transcribe' : 'Record voice input'}
              >
                {voice.isRequestingMicrophone || isTranscribingVoice ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : isRecording ? (
                  <Square className="size-3 fill-current" />
                ) : (
                  <Mic className="size-3.5" />
                )}
              </Button>

              {formatMode ? (
                <span className="ml-1 select-none text-[11px] text-muted-foreground/50">
                  {navigator.platform?.toLowerCase().includes('mac') ? '⌘' : 'Ctrl'}+Enter to send
                </span>
              ) : null}
            </div>

            <Button
              type="submit"
              disabled={!canSubmit}
              size="icon"
              className={cn(
                'size-7 rounded-full transition-all',
                canSubmit
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90 active:scale-95'
                  : 'cursor-default bg-muted text-muted-foreground/40',
              )}
              aria-label="Send message"
            >
              <ArrowUp className="size-3.5" strokeWidth={2.5} />
            </Button>
          </div>

          {voice.voiceError ? <p className="px-3 pb-2 text-xs text-destructive">{voice.voiceError}</p> : null}
        </div>
      </div>
    </form>
  )
})
