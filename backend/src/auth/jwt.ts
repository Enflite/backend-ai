import { SignJWT, jwtVerify } from 'jose';
import { AuthContext, Classification, Permission } from '../authz/permissions.js';
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

  return {
    userId: payload.sub as string,
    email: payload['email'] as string,
    displayName: payload['displayName'] as string,
    clearance: payload['clearance'] as Classification,
    tenantId: payload['tenantId'] as string,
    roleId: payload['roleId'] as string,
    roleName: payload['roleName'] as string,
    permissions: (payload['permissions'] as Permission[]) ?? [],
  };
}
