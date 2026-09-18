import { describe, expect, it } from 'vitest';
import { executeTool, getTool } from '../src/tools/gateway.js';
import type { AuthContext } from '../src/authz/permissions.js';

const auth: AuthContext = {
  userId: 'u', tenantId: 't', sessionId: 's', roleId: 'r', email: 'u@example.test',
  displayName: 'User', roleName: 'User', clearance: 'INTERNAL', permissions: ['tool:use'],
};

describe('tool gateway', () => {
  it('rejects unregistered tools instead of accepting a client endpoint', () => {
    expect(() => getTool('https://attacker.example/tool')).toThrow('Tool is not registered');
  });

  it('denies UNKNOWN data and invalid parameters before adapter execution', async () => {
    await expect(executeTool(auth, 'syteline.getItem', { item: 'A', site: 'MAIN' }, 'UNKNOWN', false, new AbortController().signal)).rejects.toMatchObject({ code: 'TOOL_CLASSIFICATION_DENIED' });
    await expect(executeTool(auth, 'syteline.getItem', { item: '../../etc/passwd', extra: true }, 'INTERNAL', false, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_TOOL_PARAMETERS' });
  });

  it('requires the server-side tool permission', async () => {
    await expect(executeTool({ ...auth, permissions: [] }, 'syteline.getItem', { item: 'A', site: 'MAIN' }, 'INTERNAL', false, new AbortController().signal)).rejects.toMatchObject({ code: 'TOOL_FORBIDDEN' });
  });
});
