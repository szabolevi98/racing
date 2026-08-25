import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const apache = fs.readFileSync(
  new URL('../deploy/apache/racing.levente.net-le-ssl.conf', import.meta.url),
  'utf8',
);
const service = fs.readFileSync(
  new URL('../deploy/systemd/racing.service', import.meta.url),
  'utf8',
);

test('élesben Apache szolgálja ki a web és shared fájlokat', () => {
  assert.match(apache, /DocumentRoot \/opt\/racing\/web/);
  assert.match(apache, /Alias \/shared\/ \/opt\/racing\/shared\//);
  assert.doesNotMatch(apache, /ProxyPass\s+\/\s/);
});

test('csak a WebSocket és az API kerül a Node-hoz', () => {
  assert.match(apache, /ProxyPass\s+\/ws\s+ws:\/\/127\.0\.0\.1:3000\/ws/);
  assert.match(apache, /ProxyPass\s+\/api\/\s+http:\/\/127\.0\.0\.1:3000\/api\//);
});

test('a Node fiatal generációja elég nagy és a szolgáltatás kap prioritást', () => {
  assert.match(service, /--max-old-space-size=512/);
  assert.match(service, /--max-semi-space-size=32/);
  assert.match(service, /^Nice=-5$/m);
});
