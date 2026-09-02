export const OPEN_PDF_IN_DEFAULT_APP_CHANNEL = 'open-pdf-in-default-app'

export type OpenPdfIpcResult =
  | { success: true }
  | { success: false; error: string }

export type OpenPdfIpcRequest =
  | { filePath: string }
  | { bytes: Uint8Array; fileName?: string }
