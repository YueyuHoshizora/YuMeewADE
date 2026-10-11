import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ProjectLedger } from '../ledger/projects.ts';
import { TaskLedger } from '../ledger/tasks.ts';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { ExecutionService } from './commands.ts';
import { TerminalService } from './terminal.ts';

async function until(check: () => boolean): Promise<void> {
// Native PTY data arrives from a real OS process; fake clocks cannot drive its events.
  for (let i = 0; i < 250; i++) { if (check()) return; await delay(20); }
  assert.fail('PTY output not reached');
}

test('real PTY recovery preserves tabs, output cursor and input while rotating owner and one-time tickets', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws);
  await projects.create({ name: 'Recovery' });
  const task = await tasks.create('Recovery', { title: 'Recovery', workspace: 'direct' });
  const execution = new ExecutionService({ ws, projects, tasks }); const terminal = new TerminalService(execution);
  const cookie = 'a'.repeat(64); const renderer = 'b'.repeat(64);
  try {
    const first = await terminal.start('Recovery', task.id, { command: process.execPath, args: ['-e', 'process.stdin.setRawMode(true);console.log("READY");process.stdin.on("data",x=>console.log("INPUT",x.toString()));setInterval(()=>{},1000)'] });
    const second = await terminal.start('Recovery', task.id, { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] });
    const ticket = terminal.bindRecovery('Recovery', task.id, first.session.id, first.owner, cookie, renderer, 'independent one').ticket;
    terminal.bindRecovery('Recovery', task.id, second.session.id, second.owner, cookie, renderer, 'independent two');
    assert.deepEqual(terminal.listRecovery(cookie, renderer).map(tab => tab.label), ['independent one', 'independent two']);
    assert.deepEqual(terminal.listRecovery('c'.repeat(64), renderer), []);
    assert.deepEqual(terminal.listRecovery(cookie, 'c'.repeat(64)), []);
    assert.throws(() => terminal.claimRecovery('Recovery', task.id, first.session.id, 'c'.repeat(64), renderer, ticket), { status: 403 });
    assert.throws(() => terminal.claimRecovery('Other', task.id, first.session.id, cookie, renderer, ticket), { status: 404 });
    await until(() => terminal.output('Recovery', task.id, first.session.id, first.owner).output.some(event => event.text.includes('READY')));
    const cursor = terminal.output('Recovery', task.id, first.session.id, first.owner).sequence;
    const claims = await Promise.allSettled([1, 2].map(async () => terminal.claimRecovery('Recovery', task.id, first.session.id, cookie, renderer, ticket)));
    assert.equal(claims.filter(result => result.status === 'fulfilled').length, 1);
    const winner = claims.find(result => result.status === 'fulfilled'); assert.ok(winner?.status === 'fulfilled');
    const resumed = winner.value;
    assert.notEqual(resumed.owner, first.owner); assert.notEqual(resumed.ticket, ticket);
    assert.equal(resumed.session.id, first.session.id); assert.equal(resumed.session.status, 'running');
    assert.throws(() => terminal.input('Recovery', task.id, first.session.id, first.owner, 'x'), { status: 403 });
    assert.throws(() => terminal.claimRecovery('Recovery', task.id, first.session.id, cookie, renderer, ticket), { status: 403 });
    terminal.input('Recovery', task.id, first.session.id, resumed.owner, 'q');
    assert.throws(() => terminal.resize('Recovery', task.id, first.session.id, first.owner, 80, 24), { status: 403 });
    await assert.rejects(terminal.stop('Recovery', task.id, first.session.id, first.owner), { status: 403 });
    await until(() => terminal.output('Recovery', task.id, first.session.id, resumed.owner, cursor).output.some(event => event.text.includes('INPUT q')));
    assert.equal(terminal.output('Recovery', task.id, second.session.id, second.owner).status, 'running');
    await terminal.stop('Recovery', task.id, first.session.id, resumed.owner);
    const stopped = terminal.claimRecovery('Recovery', task.id, first.session.id, cookie, renderer, resumed.ticket);
    assert.equal(stopped.session.status, 'stopped');
    assert.throws(() => terminal.input('Recovery', task.id, first.session.id, stopped.owner, 'q'), { status: 409 });
    const originalNow = Date.now;
    try { Date.now = () => originalNow() + 86_400_001; assert.deepEqual(terminal.listRecovery(cookie, renderer), []); assert.throws(() => terminal.claimRecovery('Recovery', task.id, first.session.id, cookie, renderer, stopped.ticket), { status: 404 }); }
    finally { Date.now = originalNow; }
    const replacement = new TerminalService(execution);
    try { assert.notEqual(replacement.recoveryGeneration, terminal.recoveryGeneration); assert.deepEqual(replacement.listRecovery(cookie, renderer), []); }
    finally { await replacement.stopAll(); }
  } finally { await terminal.stopAll(); await execution.stopAll(); }
}));
