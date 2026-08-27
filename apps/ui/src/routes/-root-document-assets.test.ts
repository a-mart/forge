import { describe, expect, it } from 'vitest'
import { normalizeRootDocumentAssetHref } from './-root-document-assets'

describe('normalizeRootDocumentAssetHref', () => {
  it.each([
    ['./assets/styles-build.css', '/./assets/styles-build.css'],
    ['http://127.0.0.1:64222/assets/styles-build.css', '/./assets/styles-build.css'],
    ['app://forge/assets/styles-build.css', '/./assets/styles-build.css'],
    ['https://forge.example/nested/assets/styles-build.css?rev=1', '/./assets/styles-build.css?rev=1'],
  ])('normalizes bundled asset href %s', (href, expected) => {
    expect(normalizeRootDocumentAssetHref(href)).toBe(expected)
  })

  it('leaves development source URLs unchanged', () => {
    expect(normalizeRootDocumentAssetHref('/src/styles.css')).toBe('/src/styles.css')
  })
})
