# Changelog

# 0.2.0 (2026-07-29)

### Bug Fixes

* bound WAL residency, self-heal torn sidecars, recalibrate RSS budget ([c19c709](https://github.com/rikoriswandha/adonisjs-periscope/commit/c19c70979e58652930c5f3608dd3f7ba865def4d)), closes [high-water](https://github.com/hi/issues/water)
* **dashboard:** add gap between application name and entry count in selector ([9658b05](https://github.com/rikoriswandha/adonisjs-periscope/commit/9658b05e49a535ebbeb79a398e43cd5e2ff8f129))
* **dashboard:** align search filters to the top of the query row ([a07c3f2](https://github.com/rikoriswandha/adonisjs-periscope/commit/a07c3f2d115ef3fbbd551f4a807241bbd851e4aa))
* **dashboard:** fall back when crypto.randomUUID is unavailable ([13e027f](https://github.com/rikoriswandha/adonisjs-periscope/commit/13e027fc92f9267b18f0ed50d2d08d97f339026c))
* **periscope:** serve deep-link relative assets and reorder batch export header ([9ec52b7](https://github.com/rikoriswandha/adonisjs-periscope/commit/9ec52b7615b3b93a1314ef32cd6dfe3ad3d15abb))
* **playground:** build dashboard before dev server ([dccee76](https://github.com/rikoriswandha/adonisjs-periscope/commit/dccee76335d58f905552a1a3df1bc10f78a8a588))
* production-readiness hardening across security, durability, and packaging ([6751d72](https://github.com/rikoriswandha/adonisjs-periscope/commit/6751d728d37fc848eb65b5bbd886f836669bb49e))

### Features

* add dashboard API and SPA ([d39fc47](https://github.com/rikoriswandha/adonisjs-periscope/commit/d39fc47c956ae7cf80af995816fb721d59f6d659))
* complete phase 8 hardening ([fb2329b](https://github.com/rikoriswandha/adonisjs-periscope/commit/fb2329be184015eea60cbfc4855546ff07b92c5c))
* **dashboard:** context-aware chart axis/ticker date labels ([1e48875](https://github.com/rikoriswandha/adonisjs-periscope/commit/1e48875615e10c3b111503a175255e6a60d0cf2f))
* **dashboard:** redesign UI with dense COSS shell ([45c1b16](https://github.com/rikoriswandha/adonisjs-periscope/commit/45c1b167ca5f34c5989bd0482398fc049d5a11d4))
* **dashboard:** replace datetime-local filters with Coss date pickers ([3aea322](https://github.com/rikoriswandha/adonisjs-periscope/commit/3aea322455c6dce86c3f5f8c084f151b891573c7))
* entry, batch context and recorder pipeline (Phase 1) ([f6b66dd](https://github.com/rikoriswandha/adonisjs-periscope/commit/f6b66dd2572a6184b7aa8c7b5dc13f807a0204b1))
* implement phase 5 packaging and commands ([66a3901](https://github.com/rikoriswandha/adonisjs-periscope/commit/66a39011fd89c99503a719a8ed9be5abebea4451))
* implement phase 6 watchers and dashboard ([1b0081b](https://github.com/rikoriswandha/adonisjs-periscope/commit/1b0081b1e8164348d9028f2de0ff7a605b9d0270))
* implement phase 7 live mode and sampling ([6492738](https://github.com/rikoriswandha/adonisjs-periscope/commit/64927384814990ea67b5a73dcea3c0fdb273fa23))
* implement phase 9 release and integrations ([b83112b](https://github.com/rikoriswandha/adonisjs-periscope/commit/b83112bf920f2a537f8baa054724a44d9100ca93))
* **playground:** showcase every watcher with self-seeding demo data ([c7744bb](https://github.com/rikoriswandha/adonisjs-periscope/commit/c7744bb8c252dcb50a9e8db91a4da4fd5fe677e0))
* rename package to @rikology/adonisjs-periscope and build dashboard in dev script ([25eb336](https://github.com/rikoriswandha/adonisjs-periscope/commit/25eb336f46e136ca9c49c255b9cec64358e2c852))
* request, query, exception, log and event watchers (Phase 3) ([8e661f6](https://github.com/rikoriswandha/adonisjs-periscope/commit/8e661f61745644959726a074fa154d8f1e3c5e8a))
* search, retention, new watchers, and dashboard overhaul ([abd4932](https://github.com/rikoriswandha/adonisjs-periscope/commit/abd4932e77464c30ffd68030086840adf39761de))
* sql storage drivers, schema and pruning (Phase 2) ([326b6ba](https://github.com/rikoriswandha/adonisjs-periscope/commit/326b6baf4bfe946e207bc173c43bec80b189827f)), closes [PeriscopeStore#save](https://github.com/PeriscopeStore/issues/save)
