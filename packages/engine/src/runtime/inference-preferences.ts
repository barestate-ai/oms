import { dirname } from 'node:path';
import { assertPrivate, isMissing, readPrivateJson, writePrivateJson } from '../workspace/storage.ts';

export const TOKEN_PLAN_PROVIDERS = ['xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp', 'xiaomi-token-plan-ams'] as const;
export type TokenPlanProvider = (typeof TOKEN_PLAN_PROVIDERS)[number];
export type MimoProvider = 'xiaomi' | TokenPlanProvider;
export interface InferencePreferences {
  version: 1;
  /** Origin of the OMS account service used for device sign-in. */
  gatewayOrigin: string;
  mimoProvider: MimoProvider | null;
}

function validate(value: unknown): InferencePreferences {
  if (!value || typeof value !== 'object') throw new Error('Invalid inference preferences');
  const p = value as Partial<InferencePreferences>;
  if (
    p.version !== 1 ||
    typeof p.gatewayOrigin !== 'string' ||
    p.gatewayOrigin.length > 2048 ||
    (p.mimoProvider !== null &&
      p.mimoProvider !== 'xiaomi' &&
      !TOKEN_PLAN_PROVIDERS.includes(p.mimoProvider as TokenPlanProvider))
  ) {
    throw new Error('Invalid inference preferences');
  }
  const origin = new URL(p.gatewayOrigin);
  const mount = origin.pathname === '/' ? '' : origin.pathname.replace(/\/$/, '');
  if (
    origin.origin + mount !== p.gatewayOrigin ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    (mount !== '' && !/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(mount)) ||
    (origin.protocol !== 'https:' &&
      !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))
  ) {
    throw new Error('Invalid gateway origin');
  }
  return { version: 1, gatewayOrigin: p.gatewayOrigin, mimoProvider: p.mimoProvider as MimoProvider | null };
}

/** The caller supplies the existing private agent directory, never a workspace path. */
export function readInferencePreferences(path: string): InferencePreferences {
  try {
    assertPrivate(dirname(path), true);
    try {
      return validate(readPrivateJson(path));
    } catch (error) {
      if (!isMissing(error)) throw error;
      return { version: 1, gatewayOrigin: 'https://barestate.xyz/oms', mimoProvider: null };
    }
  } catch {
    throw new Error('Cannot read private inference preferences');
  }
}

export function writeInferencePreferences(path: string, preferences: InferencePreferences): void {
  try {
    writePrivateJson(path, validate(preferences));
  } catch {
    throw new Error('Cannot save private inference preferences');
  }
}
