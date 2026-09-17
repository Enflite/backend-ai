-- Insert Roles
INSERT INTO roles (name) VALUES
  ('User'),
  ('Admin'),
  ('Security Admin'),
  ('AI Admin'),
  ('Developer'),
  ('Read Only')
ON CONFLICT (name) DO NOTHING;

-- Insert Permissions
INSERT INTO permissions (name) VALUES
  ('chat:create'),
  ('conversation:read'),
  ('conversation:delete'),
  ('document:upload'),
  ('document:read'),
  ('document:delete'),
  ('model:use'),
  ('model:manage'),
  ('tool:use'),
  ('tool:admin'),
  ('audit:read'),
  ('user:manage'),
  ('tenant:manage')
ON CONFLICT (name) DO NOTHING;

-- Insert Role Permissions
-- User
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'User' AND p.name IN (
  'chat:create', 'conversation:read', 'conversation:delete',
  'document:upload', 'document:read', 'model:use', 'tool:use'
)
ON CONFLICT DO NOTHING;

-- Admin (all permissions)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'Admin'
ON CONFLICT DO NOTHING;

-- Security Admin
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'Security Admin' AND p.name IN (
  'audit:read', 'user:manage', 'tenant:manage', 'conversation:read', 'document:read'
)
ON CONFLICT DO NOTHING;

-- AI Admin
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'AI Admin' AND p.name IN (
  'model:manage', 'model:use', 'tool:admin', 'tool:use', 'chat:create', 'conversation:read', 'document:read'
)
ON CONFLICT DO NOTHING;

-- Developer
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'Developer' AND p.name IN (
  'chat:create', 'conversation:read', 'document:upload', 'document:read', 'model:use', 'tool:use'
)
ON CONFLICT DO NOTHING;

-- Read Only
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'Read Only' AND p.name IN (
  'conversation:read', 'document:read'
)
ON CONFLICT DO NOTHING;

-- Insert Approved Model Placeholder
INSERT INTO models (
  name, version, provider, endpoint, status, license, source,
  context_window, capabilities, classification
) VALUES (
  'meta-llama/Meta-Llama-3.1-8B-Instruct',
  '1.0',
  'vllm',
  'http://vllm:8000/v1',
  'APPROVED',
  'llama3.1',
  'meta',
  131072,
  '{"chat": true, "streaming": true}'::jsonb,
  'INTERNAL'
) ON CONFLICT (name) DO UPDATE SET
  endpoint = EXCLUDED.endpoint,
  status = EXCLUDED.status;
