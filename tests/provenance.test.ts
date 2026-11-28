import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

test('audit provenance is derived from the actor and preserves old rows and schema', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const { actor } = store.bootstrap();
  store.db.prepare('INSERT INTO events(workspace_id,actor_id,operation,target_id,data,at) VALUES(?,?,?,?,?,?)')
    .run('fixture', actor.id, 'old_event', null, '{"historical":true}', new Date(0).toISOString());
  store.event('fixture', actor, 'system_event', null, { channel: 'browser' });
  store.event('fixture', { ...actor, channel: 'desktop' }, 'desktop_event', null, { channel: 'confirmed' });
  store.token({ ...actor, channel: 'desktop' });
  assert.ok(store.list('actor').every(record => !Object.hasOwn(record as object, 'channel')));
  const data = (store.db.prepare('SELECT data FROM events ORDER BY sequence').all() as { data: string }[])
    .map(row => JSON.parse(row.data));
  assert.deepEqual(data, [{ historical: true }, { channel: 'system' }, { channel: 'desktop' }]);
  assert.equal(store.db.pragma('user_version', { simple: true }), 1);
  assert.deepEqual((store.db.pragma('table_info(events)') as { name: string }[]).map(row => row.name),
    ['sequence', 'workspace_id', 'actor_id', 'operation', 'target_id', 'data', 'at']);
});
