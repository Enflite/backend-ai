import { SignJWT, jwtVerify } from 'jose';
import { AuthContext, CLASSIFICATIONS, Classification, PERMISSIONS, Permission } from '../authz/permissions.js';
import { config } from '../config.js';

const secretKey = new TextEncoder().encode(config.JWT_SECRET);

export async function signToken(auth: AuthContext): Promise<string> {
  return new SignJWT({
    sub: auth.userId,
    email: auth.email,
    displayName: auth.displayName,
    clearance: auth.clearance,
    tenantId: auth.tenantId,
    roleId: auth.roleId,
    roleName: auth.roleName,
    permissions: auth.permissions,
    sid: auth.sessionId,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(config.JWT_EXPIRES_IN)
    .sign(secretKey);
}

export async function verifyToken(token: string): Promise<AuthContext> {
  const { payload } = await jwtVerify(token, secretKey, {
    algorithms: ['HS256'],
  });

  const requiredStringClaims = ['sub', 'email', 'displayName', 'tenantId', 'roleId', 'roleName', 'sid'] as const;
  if (requiredStringClaims.some((claim) => typeof payload[claim] !== 'string')) {
    throw new Error('Token is missing required claims');
  }

  // Defense in depth: the middleware re-resolves role/permissions from the
  // database, but never trust claim shapes blindly even on a signed token.
  const clearance = payload['clearance'];
  if (typeof clearance !== 'string' || !(CLASSIFICATIONS as readonly string[]).includes(clearance)) {
    throw new Error('Token has an invalid clearance claim');
  }
  const permissions = payload['permissions'];
  const validPermissions = new Set<string>(PERMISSIONS as readonly string[]);
  if (
    !Array.isArray(permissions) ||
    permissions.some((permission) => typeof permission !== 'string' || !validPermissions.has(permission))
  ) {
    throw new Error('Token has invalid permission claims');
  }

  return {
    userId: payload.sub as string,
    email: payload['email'] as string,
    displayName: payload['displayName'] as string,
    clearance: clearance as Classification,
    tenantId: payload['tenantId'] as string,
    roleId: payload['roleId'] as string,
    roleName: payload['roleName'] as string,
    permissions: permissions as Permission[],
    sessionId: payload['sid'] as string,
  };
}
