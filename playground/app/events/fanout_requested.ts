import { BaseEvent } from '@adonisjs/core/events'

/**
 * The custom application event dispatched by `GET /fanout`.
 *
 * Class-based events are the v7-idiomatic form: `BaseEvent.useEmitter()` is
 * called by the core app provider during boot, so `FanoutRequested.dispatch()`
 * works without threading the emitter through by hand.
 *
 * Periscope's EventWatcher ignores framework-prefixed event names
 * (`http:`, `db:`, `mail:`, …); a class event is recorded under its constructor
 * name, so this one is guaranteed to show up.
 */
export default class FanoutRequested extends BaseEvent {
  constructor(
    public source: string,
    public itemsCount: number
  ) {
    super()
  }
}
