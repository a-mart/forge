# App Icons

This directory contains application icons for electron-builder.

## Required Icons

### macOS
- **icon.icns** — macOS icon bundle (created from PNG source)

### Windows
- **icon.ico** — Windows icon (created from PNG source, electron-builder auto-generates if PNG is provided)

### Linux
- **icon.png** — PNG icon (512x512 minimum, ideally 1024x1024)

## Creating Icons

1. Start with a high-resolution PNG (512x512 or larger)
2. Place it as `icon.png` in this directory
3. Use tools to generate platform-specific formats:
   - **macOS**: Use `png2icns` or similar tool to create `.icns`
   - **Windows**: electron-builder can auto-generate `.ico` from the PNG

electron-builder will automatically use icons from this directory during packaging.

## Placeholder

For initial development/testing, a solid-color placeholder PNG is sufficient. Production builds should use the final branded icon design.
