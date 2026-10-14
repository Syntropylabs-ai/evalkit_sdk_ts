import assert from 'node:assert';
import { ingestBody } from './_ingest.mjs';
import { enableNestjsAutoTrace, init, flush } from '../dist/index.mjs';

// enableNestjsAutoTrace(app) reads the application's own module container. It never looks a provider up
// through app.get(): Nest aborts the process when such a lookup fails, and DiscoveryService exists only when
// DiscoveryModule was imported. The handler of a health probe route is not traced, and nothing it calls is:
// the probe's request is not recorded, and each span inside it would be a trace of its own on every poll.

// Nest's decorators record route paths with reflect-metadata; a stand-in that keeps own metadata only.
if (typeof Reflect.getMetadata !== 'function') {
  const store = new WeakMap();
  const own = (target) => { let m = store.get(target); if (!m) store.set(target, (m = new Map())); return m; };
  Reflect.defineMetadata = (key, value, target) => { own(target).set(key, value); };
  Reflect.getOwnMetadata = (key, target) => store.get(target)?.get(key);
  Reflect.getMetadata = Reflect.getOwnMetadata;
  Reflect.getOwnMetadataKeys = (target) => [...(store.get(target)?.keys() ?? [])];
}

const ingested = [];
globalThis.fetch = async (_url, opts) => {
  try { for (const e of ingestBody(opts).events) ingested.push(e); } catch {}
  return { ok: true, status: 200, text: async () => 'ok' };
};
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
setTimeout(() => fail('timeout'), 20000);

class OrdersService { async find(id) { return { id }; } }
class OrdersController { constructor(s) { this.s = s; } async get(id) { return this.s.find(id); } }
const service = new OrdersService();
const controller = new OrdersController(service);
const appModule = {
  providers: new Map([[OrdersService, { instance: service }]]),
  controllers: new Map([[OrdersController, { instance: controller }]]),
};
let lookups = 0;
// Shaped like what NestFactory.create() returns: get() throws, as Nest's abort-on-error would end the process.
const app = {
  container: { getModules: () => new Map([['AppModule', appModule]]) },
  get() { lookups += 1; throw new Error('Nest could not find DiscoveryService element'); },
};

try {
  init({ subscriptionKey: 'test', baseUrl: 'http://localhost:9', serviceName: 'nest-autotrace-app-test', scheduledDelayMillis: 50 });
  const count = await enableNestjsAutoTrace(app);
  assert.strictEqual(lookups, 0, 'no provider was looked up through app.get()');
  assert.strictEqual(count, 2, 'both classes\' methods were wrapped');
  assert.deepStrictEqual(await controller.get('1001'), { id: '1001' });
  await flush();
  await new Promise((r) => setTimeout(r, 100));
  const ops = ingested.map((e) => e.operation).sort();
  assert.deepStrictEqual(ops, ['OrdersController.get', 'OrdersService.find']);
  assert.strictEqual(await enableNestjsAutoTrace({ get() { throw new Error('no'); } }), 0, 'nothing to read: 0, not a throw');
  assert.strictEqual(await enableNestjsAutoTrace(app), 0, 'a second call wraps nothing twice');

  // Probe routes, beside routes whose paths only start like one.
  class HealthService { async ping() { return 'up'; } }
  class ProbeController {
    constructor(h) { this.h = h; }
    async health() { return { status: await this.h.ping() }; }
    live() { return 'ok'; }
    readyz() { throw new Error('not ready'); }
  }
  class CareController { constructor(h) { this.h = h; } async list() { return [await this.h.ping()]; } }
  Reflect.defineMetadata('path', '/', ProbeController);
  Reflect.defineMetadata('path', 'health', ProbeController.prototype.health);
  Reflect.defineMetadata('path', ['health/live', 'livez'], ProbeController.prototype.live);
  Reflect.defineMetadata('path', 'readyz', ProbeController.prototype.readyz);
  Reflect.defineMetadata('path', 'healthcare', CareController);
  Reflect.defineMetadata('path', '/', CareController.prototype.list);
  const health = new HealthService();
  const probes = new ProbeController(health);
  const care = new CareController(health);
  const probeModule = {
    providers: new Map([[HealthService, { instance: health }]]),
    controllers: new Map([[ProbeController, { instance: probes }], [CareController, { instance: care }]]),
  };
  ingested.length = 0;
  const probeApp = { container: { getModules: () => new Map([['ProbeModule', probeModule]]) }, get() { throw new Error('no'); } };
  assert.strictEqual(await enableNestjsAutoTrace(probeApp), 2, 'HealthService.ping and CareController.list are traced');
  assert.deepStrictEqual(await probes.health(), { status: 'up' }, 'a probe handler answers as without the SDK');
  assert.strictEqual(probes.live(), 'ok', 'a synchronous one too');
  assert.throws(() => probes.readyz(), /not ready/, 'its error is thrown as raised, synchronously');
  assert.strictEqual(Reflect.getMetadata('path', ProbeController.prototype.health), 'health', 'Nest still finds the route');
  assert.deepStrictEqual(await care.list(), ['up']);
  await flush();
  await new Promise((r) => setTimeout(r, 100));
  assert.deepStrictEqual(
    ingested.filter((e) => e.spanType === 'function_call').map((e) => `${e.operation}${e.parentSpanId ? ' (child)' : ''}`).sort(),
    ['CareController.list', 'HealthService.ping (child)'],
    'nothing is recorded for a probe; /healthcare is the app\'s own route',
  );
  console.log('PASS nest-autotrace-app.e2e.mjs');
  process.exit(0);
} catch (err) {
  fail(err?.stack ?? String(err));
}
