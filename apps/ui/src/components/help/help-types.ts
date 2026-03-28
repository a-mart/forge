export type HelpCategory =
  | 'getting-started'
  | 'chat'
  | 'settings'
  | 'cortex'
  | 'models'
  | 'concepts'
  | 'terminals'
  | 'playwright'

export interface HelpArticle {
  id: string
  title: string
  category: HelpCategory
  summary: string
  content: string
  keywords: string[]
  relatedIds?: string[]
  contextKeys: string[]
}

export interface HelpTooltipContent {
  id: string
  text: string
  articleId?: string
  contextKey: string
}

export interface ShortcutDef {
  id: string
  keys: string
  keysMac?: string
  label: string
  group: string
  scope: 'global' | 'chat' | 'settings' | 'terminal'
}

export interface TourStep {
  id: string
  target: string
  title: string
  description: string
  placement: 'top' | 'bottom' | 'left' | 'right'
  action?: string
}

export interface HelpState {
  isDrawerOpen: boolean
  activeArticleId: string | null
  activeCategory: HelpCategory | null
  searchQuery: string
  contextKey: string
  isShortcutOverlayOpen: boolean
  isTourActive: boolean
  tourStep: number
  hasCompletedTour: boolean
}
