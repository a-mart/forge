# App Icons

This directory contains application icons for electron-builder.

## Current Icons

- **icon.png** — Source PNG (1024x1024)
- **icon.icns** — macOS icon bundle (generated from PNG)
- **icon.ico** — Windows icon (generated from PNG)

## Creating Icons

When updating the app icon:

1. Start with a high-resolution PNG (1024x1024 or larger)
2. Save it as `icon.png` in this directory
3. Generate platform-specific formats:
   - **macOS**: Use `png2icns` or similar tool to create `icon.icns`
   - **Windows**: Use `png2ico` or an online converter to create `icon.ico`

electron-builder uses these icons automatically during packaging.
