import { defineConfig, drivers, store } from '@adonisjs/cache'
import type { InferStores } from '@adonisjs/cache/types'

const cacheConfig = defineConfig({
  default: 'default',

  stores: {
    default: store({ prefix: 'periscope-playground' }).useL1Layer(drivers.memory()),
  },
})

export default cacheConfig

declare module '@adonisjs/cache/types' {
  interface CacheStores extends InferStores<typeof cacheConfig> {}
}
