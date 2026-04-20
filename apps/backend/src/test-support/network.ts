import { createServer } from 'node:net'

export async function getAvailablePort(host = '127.0.0.1'): Promise<number> {
  const server = createServer()

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, host, () => resolve())
    })

    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Unable to allocate port')
    }

    return address.port
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }
}
