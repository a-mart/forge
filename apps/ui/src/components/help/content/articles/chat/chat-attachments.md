You can attach files to your messages before sending. Forge supports images, text files, and binary files.

## How to attach

- Click the **paperclip** button in the input area and pick files.
- **Paste** an image from your clipboard directly into the text area.
- **Drag and drop** files onto the input area.

Attached files appear as chips above the text area. Click the X on any chip to remove it before sending.

## What gets sent

- **Images** (PNG, JPG, GIF, WebP) are sent as image attachments the agent can see.
- **Text files** are sent as text content with the filename attached.
- **Binary files** are sent as base64-encoded data.

## Per-session attachment drafts

Like text drafts, attachments are saved when you switch sessions and restored when you return. They also persist across page refreshes.

## Limits

Very large files may exceed the attachment size budget. If an upload fails or is too large, the chip won't appear. Stick to reasonably sized files for best results.

## Supported formats

Forge categorizes files automatically. Common image formats are recognized and shown as visual attachments. Text-based files (source code, configs, markdown) are read and sent as text content. Everything else is treated as binary data.
