import os from 'os';
import path from 'path';

export const TUNNEL_PROVIDER_CLOUDFLARE = 'cloudflare';
export const TUNNEL_PROVIDER_NGROK = 'ngrok';

export const TUNNEL_MODE_QUICK = 'quick';
export const TUNNEL_MODE_MANAGED_REMOTE = 'managed-remote';
export const TUNNEL_MODE_MANAGED_LOCAL = 'managed-local';
export const TUNNEL_MODE_NGROK_EPHEMERAL = 'ephemeral';
export const TUNNEL_MODE_NGROK_RESERVED = 'reserved';
export const TUNNEL_MODE_NGROK_EDGE = 'edge';

export const TUNNEL_INTENT_EPHEMERAL_PUBLIC = 'ephemeral-public';
export const TUNNEL_INTENT_PERSISTENT_PUBLIC = 'persistent-public';
export const TUNNEL_INTENT_PRIVATE_NETWORK = 'private-network';

const SUPPORTED_TUNNEL_INTENTS = new Set([
  TUNNEL_INTENT_EPHEMERAL_PUBLIC,
  TUNNEL_INTENT_PERSISTENT_PUBLIC,
  TUNNEL_INTENT_PRIVATE_NETWORK,
]);

export class TunnelServiceError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'TunnelServiceError';
    this.code = code;
    this.details = details;
  }
}

const SUPPORTED_TUNNEL_PROVIDERS = new Set([
  TUNNEL_PROVIDER_CLOUDFLARE,
  TUNNEL_PROVIDER_NGROK,
]);

const KNOWN_TUNNEL_MODES = new Set([
  TUNNEL_MODE_QUICK,
  TUNNEL_MODE_MANAGED_REMOTE,
  TUNNEL_MODE_MANAGED_LOCAL,
  TUNNEL_MODE_NGROK_EPHEMERAL,
  TUNNEL_MODE_NGROK_RESERVED,
  TUNNEL_MODE_NGROK_EDGE,
]);

export function normalizeTunnelProvider(value) {
  if (typeof value !== 'string') {
    return TUNNEL_PROVIDER_CLOUDFLARE;
  }
  const provider = value.trim().toLowerCase();
  if (!provider || !SUPPORTED_TUNNEL_PROVIDERS.has(provider)) {
    return TUNNEL_PROVIDER_CLOUDFLARE;
  }
  return provider;
}

export function normalizeTunnelMode(value) {
  if (value === undefined || value === null) {
    return TUNNEL_MODE_QUICK;
  }
  const mode = String(value).trim().toLowerCase();
  if (!mode) {
    return TUNNEL_MODE_QUICK;
  }
  if (KNOWN_TUNNEL_MODES.has(mode)) {
    return mode;
  }
  return TUNNEL_MODE_QUICK;
}

export function normalizeTunnelIntent(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const intent = value.trim().toLowerCase();
  if (!intent || !SUPPORTED_TUNNEL_INTENTS.has(intent)) {
    return undefined;
  }
  return intent;
}

function modeIntentFallback(mode) {
  if (mode === TUNNEL_MODE_QUICK || mode === TUNNEL_MODE_NGROK_EPHEMERAL) {
    return TUNNEL_INTENT_EPHEMERAL_PUBLIC;
  }
  if (
    mode === TUNNEL_MODE_MANAGED_REMOTE
    || mode === TUNNEL_MODE_MANAGED_LOCAL
    || mode === TUNNEL_MODE_NGROK_RESERVED
    || mode === TUNNEL_MODE_NGROK_EDGE
  ) {
    return TUNNEL_INTENT_PERSISTENT_PUBLIC;
  }
  return undefined;
}

function defaultModeForProvider(provider) {
  if (provider === TUNNEL_PROVIDER_NGROK) {
    return TUNNEL_MODE_NGROK_EPHEMERAL;
  }
  return TUNNEL_MODE_QUICK;
}

function normalizeTunnelModeForRequest(value, provider) {
  if (typeof value === 'string') {
    const mode = value.trim().toLowerCase();
    if (mode.length > 0) {
      return mode;
    }
  }
  return defaultModeForProvider(provider);
}

export function normalizeOptionalPath(value) {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  let resolved;
  if (trimmed === '~') {
    resolved = os.homedir();
  } else if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    resolved = path.join(os.homedir(), trimmed.slice(2));
  } else {
    resolved = path.resolve(trimmed);
  }
  const home = os.homedir();
  if (resolved !== home && !resolved.startsWith(home + path.sep)) {
    throw new TunnelServiceError(
      'validation_error',
      `Config path must be within the home directory (${home}). Got: ${resolved}`
    );
  }
  return resolved;
}

export function isSupportedTunnelMode(mode) {
  return KNOWN_TUNNEL_MODES.has(mode);
}

export function normalizeTunnelStartRequest(input = {}, defaults = {}) {
  const provider = normalizeTunnelProvider(input.provider ?? defaults.provider);
  const modeInput = input.mode
    ?? input.connectionType
    ?? defaults.mode
    ?? defaults.connectionType;
  const mode = normalizeTunnelModeForRequest(modeInput, provider);
  const explicitIntent = normalizeTunnelIntent(input.intent ?? defaults.intent);
  const intent = explicitIntent ?? modeIntentFallback(mode);
  const configPathValue = Object.prototype.hasOwnProperty.call(input, 'configPath')
    ? input.configPath
    : defaults.configPath;
  const configPath = normalizeOptionalPath(configPathValue);

  const tokenValue = input.token
    ?? input.authToken
    ?? defaults.token
    ?? defaults.authToken;
  const token = typeof tokenValue === 'string'
    ? tokenValue.trim()
    : '';

  const hostname = typeof (input.hostname ?? defaults.hostname) === 'string'
    ? (input.hostname ?? defaults.hostname).trim().toLowerCase()
    : '';

  const reservedDomain = typeof (input.reservedDomain ?? defaults.reservedDomain) === 'string'
    ? (input.reservedDomain ?? defaults.reservedDomain).trim().toLowerCase()
    : '';

  const edgeIdValue = input.edgeId
    ?? defaults.edgeId;
  const edgeId = typeof edgeIdValue === 'string' ? edgeIdValue.trim() : '';

  const endpointId = typeof (input.endpointId ?? defaults.endpointId) === 'string'
    ? (input.endpointId ?? defaults.endpointId).trim()
    : '';

  const authTokenSource = typeof (input.authTokenSource ?? defaults.authTokenSource) === 'string'
    ? (input.authTokenSource ?? defaults.authTokenSource).trim().toLowerCase()
    : '';

  return {
    provider,
    mode,
    connectionType: mode,
    intent,
    configPath,
    token,
    authToken: token,
    hostname,
    reservedDomain,
    edgeId,
    endpointId,
    authTokenSource,
  };
}

export function validateTunnelStartRequest(request, capabilities) {
  if (!request || typeof request !== 'object') {
    throw new TunnelServiceError('validation_error', 'Tunnel start request must be an object');
  }

  if (!request.provider) {
    throw new TunnelServiceError('validation_error', 'Tunnel provider is required');
  }

  if (!capabilities || capabilities.provider !== request.provider) {
    throw new TunnelServiceError('provider_unsupported', `Unsupported tunnel provider: ${request.provider}`);
  }

  if (!Array.isArray(capabilities.modes)) {
    throw new TunnelServiceError('mode_unsupported', `Provider '${request.provider}' does not declare tunnel modes`);
  }

  const modeDescriptor = capabilities.modes.find((entry) => entry?.key === request.mode);
  if (!modeDescriptor) {
    throw new TunnelServiceError('mode_unsupported', `Provider '${request.provider}' does not support mode '${request.mode}'`);
  }

  if (typeof request.intent === 'string' && request.intent.length > 0) {
    if (!SUPPORTED_TUNNEL_INTENTS.has(request.intent)) {
      throw new TunnelServiceError('validation_error', `Unsupported tunnel intent: ${request.intent}`);
    }
    if (modeDescriptor.intent !== request.intent) {
      throw new TunnelServiceError(
        'validation_error',
        `Tunnel intent '${request.intent}' does not match mode '${request.mode}' (expected '${modeDescriptor.intent}')`
      );
    }
  }

  const requiredFields = Array.isArray(modeDescriptor.requires) ? modeDescriptor.requires : [];

  if (requiredFields.includes('token')) {
    if (!request.token) {
      const allowsConfigTokenFallback = request.provider === TUNNEL_PROVIDER_NGROK && Boolean(request.configPath);
      if (!allowsConfigTokenFallback && request.mode === TUNNEL_MODE_MANAGED_REMOTE) {
        throw new TunnelServiceError('validation_error', 'Managed remote tunnel token is required');
      }
      if (!allowsConfigTokenFallback) {
        throw new TunnelServiceError('validation_error', `Mode '${request.mode}' requires a token`);
      }
    }
  }

  if (requiredFields.includes('hostname')) {
    if (!request.hostname) {
      throw new TunnelServiceError('validation_error', 'Managed remote tunnel hostname is required');
    }
  }

  if (requiredFields.includes('configPath')) {
    if (request.configPath === undefined || request.configPath === null || request.configPath === '') {
      throw new TunnelServiceError('validation_error', `Mode '${request.mode}' requires a configPath`);
    }
  }

  if (requiredFields.includes('reservedDomain')) {
    if (!request.reservedDomain && !request.configPath) {
      throw new TunnelServiceError('validation_error', `Mode '${request.mode}' requires a reservedDomain`);
    }
  }

  if (requiredFields.includes('edgeId')) {
    if (!request.edgeId && !request.endpointId && !request.configPath) {
      throw new TunnelServiceError('validation_error', `Mode '${request.mode}' requires an edgeId`);
    }
  }
}
