export type MentionMenuStatus =
  | 'list'
  | 'loading'
  | 'error'
  | 'empty-catalog'
  | 'empty-filter'

export function mentionMenuOptionId(listboxId: string, index: number): string {
  return `${listboxId}-option-${index}`
}

export function mentionMenuActiveDescendantId(
  listboxId: string,
  status: MentionMenuStatus,
  selectedIndex: number,
): string | undefined {
  if (status !== 'list') {
    return undefined
  }
  return mentionMenuOptionId(listboxId, selectedIndex)
}
