const { app, safeStorage } = require('electron')

const SAFE_MARKER = 'forge-safe-storage-interop-marker'

app.whenReady().then(async () => {
  try {
    const asyncAvailable = await safeStorage.isAsyncEncryptionAvailable()
    if (!asyncAvailable) {
      process.stdout.write(JSON.stringify({
        ok: false,
        code: 'async-storage-unavailable',
      }))
      app.exit(2)
      return
    }

    const syncCiphertext = safeStorage.encryptString(SAFE_MARKER)
    const asyncDecrypted = await safeStorage.decryptStringAsync(syncCiphertext)
    const asyncCiphertext = await safeStorage.encryptStringAsync(SAFE_MARKER)
    const syncDecrypted = safeStorage.decryptString(asyncCiphertext)

    process.stdout.write(JSON.stringify({
      ok:
        asyncDecrypted.result === SAFE_MARKER
        && syncDecrypted === SAFE_MARKER,
      syncToAsync: asyncDecrypted.result === SAFE_MARKER,
      asyncToSync: syncDecrypted === SAFE_MARKER,
      shouldReEncrypt: asyncDecrypted.shouldReEncrypt,
    }))
    app.exit(0)
  } catch {
    process.stdout.write(JSON.stringify({
      ok: false,
      code: 'safe-storage-operation-failed',
    }))
    app.exit(1)
  }
})

app.on('window-all-closed', () => {
  app.quit()
})
