import { pathToFileURL } from 'node:url'
process.env.MRC_CHANNEL_NO_BOOT = '1'
const target = process.argv[2] ? pathToFileURL(process.argv[2]).href : new URL('../../container/mrc-channel-server.js', import.meta.url).href
await import(target)
console.log('CHANNEL_SERVER_LOADED_OK')
