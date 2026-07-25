'use strict'

module.exports = async function afterSign(context) {
  const hooks = await import('./electron-builder-external-chrome.mjs')
  await hooks.afterSignExternalChrome(context)
}
