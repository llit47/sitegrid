import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { taskFixture } from './helpers/task-management-fixture.js';

test('dashboard totals cover all authorized active tasks beyond pagination under runtime RLS', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const f = await taskFixture();
  try {
    const base = `/api/organizations/${f.organizations.a}`;
    const create = async (title: string, assigneeMembershipId: string | null = null, projectId = f.projects[0]) => {
      const response = await f.app.inject({ method: 'POST', url: `${base}/projects/${projectId}/tasks`, headers: f.headers.manager, payload: { title, assigneeMembershipId } });
      assert.equal(response.statusCode, 201, response.body); return response.json().task;
    };
    for (let i = 0; i < 105; i++) await create(`Backlog ${i}`);
    const todo = await create('Do zrobienia pracownika', f.members.worker);
    const work = await create('Własne pracownika', f.members.worker);
    const other = await create('Własne innego', f.members.other);
    const submitted = await create('Do odbioru pracownika', f.members.worker);
    const archived = await create('Archiwalne', null, f.projects[1]);
    await f.owner.query("UPDATE projects SET status='archived', version=version+1 WHERE id=$1", [archived.projectId ?? f.projects[1]]);
    for (const [task, actor, actions] of [[work, 'worker', ['start']], [other, 'other', ['start']], [submitted, 'worker', ['start','submit']]] as const) {
      for (let i = 0; i < actions.length; i++) {
        const response = await f.app.inject({ method: 'POST', url: `${base}/projects/${f.projects[0]}/tasks/${task.id}/commands`, headers: f.headers[actor], payload: { operationId: randomUUID(), schemaVersion: 1, action: actions[i], expectedVersion: i + 1 } });
        assert.equal(response.statusCode, 200, response.body);
      }
    }
    const list = await f.app.inject({ url: `${base}/tasks`, headers: f.headers.manager });
    assert.equal(list.json().tasks.length, 100); assert.equal(list.json().hasMore, true);
    for (const actor of ['admin','manager','foreman']) {
      const response = await f.app.inject({ url: `${base}/task-summary`, headers: f.headers[actor] });
      assert.equal(response.statusCode, 200, response.body);
      const result = response.json();
      assert.equal(result.total, 109); assert.equal(result.backlog, 105);
      assert.equal(result.todo, 1); assert.equal(result.in_progress, 2); assert.equal(result.submitted, 1);
      assert.equal(result.scope, 'company'); assert.equal(result.attention.length, 8);
      assert.equal(result.attention[0].id, submitted.id);
      assert(!JSON.stringify(result).includes('Archiwalne'));
    }
    const worker = (await f.app.inject({ url: `${base}/task-summary`, headers: f.headers.worker })).json();
    assert.equal(worker.total, 3); assert.equal(worker.backlog, 0); assert.equal(worker.scope, 'mine');
    assert.deepEqual(worker.attention.map((task: { id: string }) => task.id), [todo.id, work.id]);
    assert(!JSON.stringify(worker).includes(other.id));
    for (const actor of ['roleless','foreign','platform']) {
      const denied = await f.app.inject({ url: `${base}/task-summary`, headers: f.headers[actor] });
      assert.equal(denied.statusCode, 403, denied.body);
    }
    assert.equal((await f.app.inject({ url: `${base}/task-summary` })).statusCode, 401);
    await f.owner.query("DELETE FROM membership_roles WHERE membership_id=$1 AND role='worker'", [f.members.worker]);
    assert.equal((await f.app.inject({ url: `${base}/task-summary`, headers: f.headers.worker })).statusCode, 403);
  } finally { await f.close(); }
});
