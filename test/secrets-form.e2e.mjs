import assert from 'node:assert';
import { scrubSecrets } from '../dist/index.mjs';

const body = (value) =>
  scrubSecrets({ traceId: 't', spanId: 's', spanType: 'http_call', createdAt: 'now', attributes: { 'http.request.body': value } })
    .attributes['http.request.body'];

// A form login body keeps the user and masks the password.
assert.strictEqual(body('username=alice&password=DUMMY-hunter2-pw'), 'username=alice&password=***');

// An OAuth token request masks its client secret and refresh token.
const token = body('grant_type=refresh_token&client_id=app1&client_secret=dummy-secret&refresh_token=dummy-refresh');
assert.ok(!token.includes('dummy-secret') && !token.includes('dummy-refresh'), token);
assert.ok(token.includes('grant_type=refresh_token') && token.includes('client_id=app1'), token);

// Prose with an equals sign is left as it is.
assert.strictEqual(body('set x=1 and y=2'), 'set x=1 and y=2');
assert.strictEqual(body('a=b'), 'a=b');

// A bracketed field name (Rails, Laravel, PHP) is matched by its parts, encoded or not.
for (const [raw, expected] of [
  ['user%5Bemail%5D=a%40b.c&user%5Bpassword%5D=DUMMY-pw', 'user%5Bemail%5D=a%40b.c&user%5Bpassword%5D=***'],
  ['session%5Bpassword%5D=DUMMY-pw&commit=Log+in', 'session%5Bpassword%5D=***&commit=Log+in'],
  ['user[password]=DUMMY-pw&user[remember_me]=1', 'user[password]=***&user[remember_me]=1'],
  ['items[0][api_key]=DUMMY-k&items[0][name]=a', 'items[0][api_key]=***&items[0][name]=a'],
  ['user[password][confirmation]=DUMMY-pw', 'user[password][confirmation]=***'],
  ['user[max_tokens]=5&user[name]=alice', 'user[max_tokens]=5&user[name]=alice'],
]) {
  assert.strictEqual(body(raw), expected, raw);
}
const url = scrubSecrets({ traceId: 't', spanId: 's', spanType: 'http_call', createdAt: 'now', attributes: { 'http.url': 'https://example.com/login?user[password]=DUMMY-pw&next=/home' } })
  .attributes['http.url'];
assert.strictEqual(url, 'https://example.com/login?user[password]=***&next=/home');

console.log('secrets-form: PASS');
