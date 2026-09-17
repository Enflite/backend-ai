import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { Errors } from '../errors.js';
import { verifyPassword } from './password.js';
import { signToken } from './jwt.js';
import { requireAuth } from './middleware.js';
import { recordAudit } from '../audit/audit.js';
import { AuthContext, Classification, Permission, ROLE_PERMISSIONS } from '../authz/permissions.js';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  tenantId: z.string().uuid().optional(),
});

const devLoginSchema = z.object({
  email: z.string().email(),
  tenantId: z.string().uuid().optional(),
});

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  is_active: boolean;
  clearance: Classification;
}

interface MembershipRow {
  tenant_id: string;
  tenant_name: string;
  role_id: string;
  role_name: string;
}

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /auth/login
  fastify.post(
    '/auth/login',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
        },
      },
    },
    async (req, reply) => {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Errors.badRequest('INVALID_REQUEST', 'Invalid login request', parsed.error.format());
      }

      const { email, password, tenantId } = parsed.data;

      const userRes = await query<UserRow>(
        'SELECT id, email, password_hash, display_name, is_active, clearance FROM users WHERE email = $1',
        [email]
      );

      const user = userRes.rows[0];
      if (!user || !user.is_active) {
        await recordAudit({
          action: 'LOGIN',
          success: false,
          reason: 'Invalid credentials or inactive user',
          ip: req.ip,
          requestId: req.requestId,
        });
        throw Errors.unauthorized('INVALID_CREDENTIALS', 'Invalid email or password');
      }

      const isValidPassword = await verifyPassword(password, user.password_hash);
      if (!isValidPassword) {
        await recordAudit({
          userId: user.id,
          action: 'LOGIN',
          success: false,
          reason: 'Invalid credentials',
          ip: req.ip,
          requestId: req.requestId,
        });
        throw Errors.unauthorized('INVALID_CREDENTIALS', 'Invalid email or password');
      }

      const memberRes = await query<MembershipRow>(
        `SELECT m.tenant_id, t.name as tenant_name, r.id as role_id, r.name as role_name
         FROM memberships m
         JOIN tenants t ON t.id = m.tenant_id
         JOIN roles r ON r.id = m.role_id
         WHERE m.user_id = $1`,
        [user.id]
      );

      if (memberRes.rows.length === 0) {
        await recordAudit({
          userId: user.id,
          action: 'LOGIN',
          success: false,
          reason: 'No tenant membership',
          ip: req.ip,
          requestId: req.requestId,
        });
        throw Errors.forbidden('NO_TENANT_MEMBERSHIP', 'User has no tenant memberships');
      }

      let selectedMembership: MembershipRow;
      if (tenantId) {
        const found = memberRes.rows.find((m) => m.tenant_id === tenantId);
        if (!found) {
          throw Errors.forbidden('INVALID_TENANT', 'User is not a member of the requested tenant');
        }
        selectedMembership = found;
      } else {
        selectedMembership = memberRes.rows[0]!;
      }

      // Load permissions from DB and fallback/merge with ROLE_PERMISSIONS
      const permRes = await query<{ name: Permission }>(
        `SELECT p.name FROM permissions p
         JOIN role_permissions rp ON rp.permission_id = p.id
         WHERE rp.role_id = $1`,
        [selectedMembership.role_id]
      );

      const staticPerms = ROLE_PERMISSIONS[selectedMembership.role_name] ?? [];
      const dbPerms = permRes.rows.map((r) => r.name);
      const permissions = Array.from(new Set([...staticPerms, ...dbPerms])) as Permission[];

      const authContext: AuthContext = {
        userId: user.id,
        email: user.email,
        displayName: user.display_name,
        clearance: user.clearance,
        tenantId: selectedMembership.tenant_id,
        roleId: selectedMembership.role_id,
        roleName: selectedMembership.role_name,
        permissions,
      };

      const token = await signToken(authContext);

      await recordAudit({
        tenantId: authContext.tenantId,
        userId: authContext.userId,
        requestId: req.requestId,
        ip: req.ip,
        action: 'LOGIN',
        success: true,
      });

      return reply.send({
        token,
        user: authContext,
        tenant: {
          id: selectedMembership.tenant_id,
          name: selectedMembership.tenant_name,
        },
      });
    }
  );

  // POST /auth/dev-login (only if DEV_AUTH_ENABLED)
  if (config.DEV_AUTH_ENABLED) {
    fastify.post('/auth/dev-login', async (req, reply) => {
      const parsed = devLoginSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Errors.badRequest('INVALID_REQUEST', 'Invalid dev-login request', parsed.error.format());
      }

      const { email, tenantId } = parsed.data;

      const userRes = await query<UserRow>(
        'SELECT id, email, password_hash, display_name, is_active, clearance FROM users WHERE email = $1',
        [email]
      );

      const user = userRes.rows[0];
      if (!user || !user.is_active) {
        throw Errors.unauthorized('USER_NOT_FOUND', 'Dev user not found or inactive');
      }

      const memberRes = await query<MembershipRow>(
        `SELECT m.tenant_id, t.name as tenant_name, r.id as role_id, r.name as role_name
         FROM memberships m
         JOIN tenants t ON t.id = m.tenant_id
         JOIN roles r ON r.id = m.role_id
         WHERE m.user_id = $1`,
        [user.id]
      );

      if (memberRes.rows.length === 0) {
        throw Errors.forbidden('NO_TENANT_MEMBERSHIP', 'Dev user has no tenant memberships');
      }

      let selectedMembership: MembershipRow;
      if (tenantId) {
        const found = memberRes.rows.find((m) => m.tenant_id === tenantId);
        if (!found) {
          throw Errors.forbidden('INVALID_TENANT', 'User is not a member of the requested tenant');
        }
        selectedMembership = found;
      } else {
        selectedMembership = memberRes.rows[0]!;
      }

      const permRes = await query<{ name: Permission }>(
        `SELECT p.name FROM permissions p
         JOIN role_permissions rp ON rp.permission_id = p.id
         WHERE rp.role_id = $1`,
        [selectedMembership.role_id]
      );

      const staticPerms = ROLE_PERMISSIONS[selectedMembership.role_name] ?? [];
      const dbPerms = permRes.rows.map((r) => r.name);
      const permissions = Array.from(new Set([...staticPerms, ...dbPerms])) as Permission[];

      const authContext: AuthContext = {
        userId: user.id,
        email: user.email,
        displayName: user.display_name,
        clearance: user.clearance,
        tenantId: selectedMembership.tenant_id,
        roleId: selectedMembership.role_id,
        roleName: selectedMembership.role_name,
        permissions,
      };

      const token = await signToken(authContext);

      await recordAudit({
        tenantId: authContext.tenantId,
        userId: authContext.userId,
        requestId: req.requestId,
        ip: req.ip,
        action: 'DEV_LOGIN',
        success: true,
      });

      return reply.send({
        token,
        user: authContext,
        tenant: {
          id: selectedMembership.tenant_id,
          name: selectedMembership.tenant_name,
        },
      });
    });
  }

  // GET /me
  fastify.get(
    '/me',
    {
      preHandler: [requireAuth],
    },
    async (req, reply) => {
      return reply.send(req.auth);
    }
  );
}
