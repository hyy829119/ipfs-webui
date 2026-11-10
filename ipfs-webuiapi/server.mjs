import { createHost, readConfig } from './host.mjs'
import { createLogger } from './logger.mjs'

let host
let logger
try {
  const config = readConfig()
  logger = createLogger({ level: config.logLevel })
  host = await createHost({ ...config, logger })
  await new Promise((resolve, reject) => {
    host.server.once('error', reject)
    host.server.listen(config.port, config.host, resolve)
  })
  if (config.logLevel === 'info') {
    console.info(`IFShare WebUI API listening on ${config.host}:${config.port}`)
    console.info(config.databaseType === 'sqlite'
      ? `SQLite database: ${config.databasePath}`
      : `Database: ${config.databaseType} ${config.databaseHost}:${config.databasePort}/${config.databaseName}`)
  }
  logger.info({ event: 'service_started', port: config.port, databaseType: config.databaseType })
  let closing
  const shutdown = () => {
    if (!closing) {
      closing = (async () => {
        logger.info({ event: 'service_stopping' })
        try {
          await host.close()
          logger.info({ event: 'service_stopped' })
          process.exitCode = 0
        } catch (error) {
          logger.error({ event: 'service_shutdown_failed', code: error.code || 'SHUTDOWN_ERROR', dbCode: error.dbCode })
          process.exitCode = 1
        } finally { logger.close() }
      })()
    }
    return closing
  }
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, shutdown)
  }
} catch (error) {
  console.error(`IFShare WebUI API failed to start: ${error.code === 'DATABASE_ERROR' ? error.message : error.code || error.message}`)
  try { if (host) await host.close() } catch (cleanupError) {
    logger?.error({ event: 'service_cleanup_failed', code: cleanupError.code || 'CLEANUP_ERROR', dbCode: cleanupError.dbCode })
  } finally { logger?.close() }
  process.exitCode = 1
}
