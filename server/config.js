import { normalizePhysicsAuthority } from '../shared/protocol.js';

export function physicsAuthorityFromEnv(env = process.env) {
  return normalizePhysicsAuthority(env.PHYSICS_AUTHORITY);
}

export const physicsAuthority = physicsAuthorityFromEnv();
