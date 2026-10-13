import { describe, expect, it } from 'vitest';
import { createCli } from '../../src/cli/index.js';

const action = ['--approved-url', 'http://127.0.0.1:3000/', '--selector', '#reserve', '--action', 'click'];
const cases = [
  ['doctor', []],
  ['connect', []],
  ['tabs', []],
  ['inspect', ['--selector', '#reserve']],
  ['schedule', [...action, '--at', '2100-01-01T00:00:00Z']],
  ['watch', [...action, '--when', 'enabled']],
  ['arm', [...action, '--at', '2100-01-01T00:00:00Z', '--when', 'enabled']],
  ['status', ['job-123']],
  ['cancel', ['job-123']],
  ['logs', []],
  ['benchmark', ['--iterations', '1']],
  ['mcp', []],
] as const;

describe('fa command routing', () => {
  it.each(cases)('routes --%s to its action', async (name, args) => {
    // Given: isolate parsing from backend and IPC actions.
    const program = createCli().exitOverride();
    let selected = '';
    for (const command of program.commands) command.action(() => { selected = command.name(); });
    // When
    await program.parseAsync(['node', 'fa', `--${name}`, ...args]);
    // Then
    expect(selected).toBe(`--${name}`);
  });

  it('preserves flag-shaped option values instead of treating them as another command', async () => {
    // Given
    const program = createCli().exitOverride();
    const watch = program.commands.find(command => command.name() === '--watch');
    if (!watch) throw new Error('Missing watch command');
    let value: unknown;
    watch.action(() => { value = watch.getOptionValue('value'); });
    // When
    await program.parseAsync(['node', 'fa', '--watch', ...action, '--when', 'text', '--value', '--status']);
    // Then
    expect(value).toBe('--status');
  });

  it('rejects unknown commands without dispatching an action', async () => {
    // Given
    const program = createCli().exitOverride().configureOutput({ writeErr: () => undefined });
    let dispatched = false;
    for (const command of program.commands) command.action(() => { dispatched = true; });
    // When / Then
    await expect(program.parseAsync(['node', 'fa', '--unsupported'])).rejects.toMatchObject({ code: 'commander.unknownOption' });
    expect(dispatched).toBe(false);
  });
});
