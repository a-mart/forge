/**
 * Format a kebab-case category string into title case.
 * e.g. "getting-started" → "Getting Started"
 */
export function formatCategory(category: string): string {
  return category
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}
