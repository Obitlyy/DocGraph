const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('docgraph', {
  platform: process.platform,
  version: require('./package.json').version,
})
