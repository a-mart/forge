export async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T> | T): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: platform })

  try {
    return await run()
  } finally {
    if (descriptor) {
      Object.defineProperty(process, 'platform', descriptor)
    }
  }
}
