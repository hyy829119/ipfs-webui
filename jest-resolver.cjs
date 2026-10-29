// Match the relative .js/.jsx extension aliases in config-overrides.js.
module.exports = (request, options) => {
  try {
    return options.defaultResolver(request, options)
  } catch (error) {
    if (request.startsWith('.') && /\.jsx?$/.test(request)) {
      const extensions = request.endsWith('.jsx') ? ['.tsx'] : ['.ts', '.tsx']
      for (const extension of extensions) {
        try {
          return options.defaultResolver(request.replace(/\.jsx?$/, extension), options)
        } catch {}
      }
    }
    throw error
  }
}
