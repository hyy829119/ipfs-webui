// Resolve gateways per request so startup order and saved settings cannot pin
// the inspector to a stale localhost address. Raw block validation stays in Helia.
export function createExplorerBroker (getGateways) {
  return () => ({
    async retrieve (cid, options = {}) {
      const { local, server } = getGateways()
      const gateways = [...new Set([local, server].filter(Boolean))]
      let failure = new Error('No content gateway is configured')
      for (const gateway of gateways) {
        if (options.signal?.aborted) throw new Error('Inspection cancelled')
        const isLocal = gateway === local && gateway !== server
        const controller = new AbortController()
        const abort = () => controller.abort()
        options.signal?.addEventListener('abort', abort)
        const timer = setTimeout(abort, isLocal ? 1500 : 30000)
        try {
          const url = `${gateway.replace(/\/+$/, '')}/ipfs/${cid.toString()}?format=raw`
          const response = await fetch(url, {
            signal: controller.signal,
            credentials: isLocal ? 'omit' : 'same-origin',
            headers: { Accept: 'application/vnd.ipld.raw' },
            cache: 'no-store',
            referrerPolicy: 'no-referrer'
          })
          if (!response.ok) throw new Error(`Gateway returned ${response.status}`)
          const block = new Uint8Array(await response.arrayBuffer())
          if (controller.signal.aborted) throw new Error('Gateway request timed out')
          await options.validateFn?.(block)
          return block
        } catch (error) {
          failure = error
          if (options.signal?.aborted) throw error
        } finally {
          clearTimeout(timer)
          options.signal?.removeEventListener('abort', abort)
        }
      }
      throw failure
    }
  })
}
