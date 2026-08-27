const BUNDLED_ASSET_PATH_MARKER = '/assets/'

/**
 * Keep bundled document assets byte-identical between SSR and hydration.
 *
 * With Vite's relative production base, SSR receives `./assets/...` while the
 * browser module receives an absolute URL. React matches hoisted head resources
 * by their literal href, so both forms must converge before HeadContent renders.
 * `/./assets/...` also resolves from nested web routes and Forge's app:// origin.
 */
export function normalizeRootDocumentAssetHref(href: string): string {
  const assetPathIndex = href.lastIndexOf(BUNDLED_ASSET_PATH_MARKER)
  return assetPathIndex === -1
    ? href
    : `/.${href.slice(assetPathIndex)}`
}
