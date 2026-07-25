# Third-Party Notices

## T3 Code

Forge browser automation includes source adapted from T3 Code commit 9a0a07167f0623c3a7db0ffeff2e3939760309df.

MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

### Substantial adapted-file mapping

| Forge file | T3 Code reference |
| --- | --- |
| `packages/protocol/src/browser-automation.ts` | Browser operation semantics, bounds, and viewport presets at `9a0a07167f0623c3a7db0ffeff2e3939760309df` |
| `apps/electron/src/browser/managed-electron-target-adapter.ts` | `apps/desktop/src/preview/Manager.ts` |
| `apps/electron/src/browser/browser-session.ts` | `apps/desktop/src/preview/BrowserSession.ts` |
| `apps/electron/src/browser/playwright-injected-runtime.ts` | `apps/desktop/src/preview/PlaywrightInjectedRuntime.ts` |
| `apps/electron/src/browser/guest-preload.ts` | GuestProtocol / PickPreload |
| `apps/electron/src/browser/browser-webview-security.ts` | `DesktopWindow.ts` |
| `apps/electron/src/browser/browser-keyboard.ts` | `PreviewKeyboard.ts` |
| `apps/electron/src/browser/trusted-browser-bridge.ts` | `browserRecording.ts` |

## Playwright

playwright-core 1.60.0 is distributed with its LICENSE, NOTICE, and ThirdPartyNotices.txt files under `browser-runtime/playwright-core/`.
