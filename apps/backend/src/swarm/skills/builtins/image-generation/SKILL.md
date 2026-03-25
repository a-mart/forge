---
name: image-generation
description: Generate images using Google Gemini (gemini-3-pro-image-preview). Requires GEMINI_API_KEY.
envVars:
  - name: GEMINI_API_KEY
    description: Google AI Studio / Gemini API key
    required: true
---

# Image Generation

Generate images using Google Gemini (`gemini-3-pro-image-preview`).

Run from this skill directory:

```bash
node ./generate.js \
  --prompt "a cute robot bee in a garden" \
  --output "/path/to/output.png"
```

## Options

- `--prompt` (required): text description of the image to generate
- `--output` (required): output file path (extension auto-detected when omitted)
- `--aspect-ratio` (optional): aspect ratio like `16:9`, `1:1`, `4:3`
- `--size` (optional): image size, default `1K`

## Output

The script prints JSON:

- Success: `{ "ok": true, "file": "/path/to/output.png", "mimeType": "image/png" }`
- Failure: `{ "ok": false, "error": "..." }`
