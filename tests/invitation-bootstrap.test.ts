import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureInvitationToken } from '../apps/web/src/invitation-bootstrap.js';

test('invitation bootstrap synchronously removes only the fragment and preserves history state', () => {
  const location = new URL('https://sitegrid.example/invitations/accept?source=email&next=%2F#synthetic-token');
  const state = { source: 'email' };
  let replacements = 0;
  const history = { state, replaceState(data: unknown, unused: string, url?: string | URL | null) {
    assert.strictEqual(data, state);
    assert.equal(unused, '');
    location.href = new URL(String(url), location).href;
    replacements++;
  } };
  const token = captureInvitationToken({ location, history });
  assert.equal(token, 'synthetic-token');
  assert.equal(location.href, 'https://sitegrid.example/invitations/accept?source=email&next=%2F');
  assert.equal(replacements, 1);
  assert.equal(captureInvitationToken({ location, history }), '');
  assert.equal(replacements, 1);
  assert.equal(token, 'synthetic-token'); // the captured value outlives URL sanitization
});

test('bootstrap leaves ordinary URL fragments and fragment-free invitation URLs unchanged', () => {
  for (const path of ['/?source=email#section', '/invitations/accept?source=email']) {
    const location = new URL(path, 'https://sitegrid.example');
    const history = { state: null, replaceState() { assert.fail('Unexpected history replacement'); } };
    assert.equal(captureInvitationToken({ location, history }), '');
    assert.equal(location.href, new URL(path, 'https://sitegrid.example').href);
  }
});
