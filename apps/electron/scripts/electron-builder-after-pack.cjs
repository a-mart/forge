'use strict'

module.exports = async function afterPack(context) {
  const hooks = await import('./electron-builder-external-chrome.mjs')
  await hooks.afterPackExternalChrome(context)
}
