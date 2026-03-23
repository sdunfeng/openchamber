import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';

const DEFAULT_STARTUP_TIMEOUT_MS = 30000;

const READY_LOG_PATTERNS = [
  /started tunnel/i,
  /forwarding/i,
  /started tunnel session/i,
];

const FATAL_LOG_PATTERNS = [
  /failed to start tunnel/i,
  /authentication failed/i,
  /invalid authtoken/i,
  /ERR_NGROK_/i,
  /failed.*edge/i,
  /failed.*domain/i,
  /forbidden/i,
  /unauthorized/i,
];

const HTTPS_URL_REGEX = /https:\/\/[^\s"')]+/i;
const NGROK_CONFIG_PATH_PATTERNS = [
  /Valid configuration file at\s+(.+)$/im,
  /\(default\s+([^)]+ngrok\.yml)\)/im,
  /at\s+([^\n]+ngrok\.yml)/im,
];

async function searchPathFor(command) {
  const pathValue = process.env.PATH || '';
  const segments = pathValue.split(path.delimiter).filter(Boolean);
  const windowsExtensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
      .split(';')
      .map((ext) => ext.trim().toLowerCase())
      .filter(Boolean)
      .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`))
    : [''];

  for (const dir of segments) {
    for (const ext of windowsExtensions) {
      const fileName = process.platform === 'win32' ? `${command}${ext}` : command;
      const candidate = path.join(dir, fileName);
      try {
        const stats = fs.statSync(candidate);
        if (!stats.isFile()) {
          continue;
        }
        if (process.platform !== 'win32') {
          try {
            fs.accessSync(candidate, fs.constants.X_OK);
          } catch {
            continue;
          }
        }
        return candidate;
      } catch {
        continue;
      }
    }
  }

  return null;
}

function parseLogLineCandidateUrl(line) {
  if (typeof line !== 'string' || line.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(line);
    const candidate = typeof parsed?.url === 'string'
      ? parsed.url
      : (typeof parsed?.obj?.url === 'string' ? parsed.obj.url : '');
    if (candidate) {
      const matched = candidate.match(HTTPS_URL_REGEX);
      if (matched && matched[0]) {
        return matched[0];
      }
    }
  } catch {
    // Non-JSON log line.
  }

  const matched = line.match(HTTPS_URL_REGEX);
  if (matched && matched[0]) {
    return matched[0];
  }
  return null;
}

function isReadyLogLine(line) {
  if (!line) {
    return false;
  }
  return READY_LOG_PATTERNS.some((pattern) => pattern.test(line));
}

function isFatalLogLine(line) {
  if (!line) {
    return false;
  }
  return FATAL_LOG_PATTERNS.some((pattern) => pattern.test(line));
}

function stripWrappingQuotes(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function extractConfigPathFromOutput(output) {
  if (typeof output !== 'string' || output.trim().length === 0) {
    return '';
  }
  for (const pattern of NGROK_CONFIG_PATH_PATTERNS) {
    const match = output.match(pattern);
    if (!match?.[1]) {
      continue;
    }
    const candidate = stripWrappingQuotes(match[1]).trim();
    if (candidate.length > 0) {
      return candidate;
    }
  }
  return '';
}

function parseAuthtokenFromLine(line) {
  if (typeof line !== 'string') {
    return '';
  }
  const match = line.match(/^\s*authtoken\s*:\s*(.+)$/i);
  if (!match?.[1]) {
    return '';
  }
  const withoutComment = match[1].replace(/\s+#.*$/, '').trim();
  if (!withoutComment) {
    return '';
  }
  return stripWrappingQuotes(withoutComment);
}

function normalizeEndpointUrl(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  try {
    const parsed = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    const host = parsed.host.trim().toLowerCase();
    const pathName = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '';
    const suffix = pathName || parsed.search || parsed.hash
      ? `${pathName}${parsed.search || ''}${parsed.hash || ''}`
      : '';
    return `${host}${suffix}`;
  } catch {
    return trimmed.toLowerCase().replace(/^https?:\/\//i, '').replace(/\/$/, '');
  }
}

function endpointDomainFromUrl(value) {
  const normalized = normalizeEndpointUrl(value);
  if (!normalized) {
    return '';
  }
  const slashIndex = normalized.indexOf('/');
  return slashIndex >= 0 ? normalized.slice(0, slashIndex) : normalized;
}

function readNgrokConfigValues(configRaw) {
  const tokenFromLineParse = resolveNgrokAuthTokenInput(configRaw);

  let parsed = null;
  try {
    parsed = yaml.parse(configRaw);
  } catch {
    return {
      token: tokenFromLineParse,
      endpoints: [],
      parseError: true,
    };
  }

  const parsedToken = typeof parsed?.agent?.authtoken === 'string'
    ? parsed.agent.authtoken.trim()
    : (typeof parsed?.authtoken === 'string' ? parsed.authtoken.trim() : '');

  const endpoints = Array.isArray(parsed?.endpoints)
    ? parsed.endpoints
      .map((entry) => {
        const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
        const url = typeof entry?.url === 'string' ? entry.url.trim() : '';
        const domain = endpointDomainFromUrl(url);
        return {
          name,
          url,
          domain,
        };
      })
      .filter((entry) => entry.name || entry.url || entry.domain)
    : [];

  return {
    token: parsedToken || tokenFromLineParse,
    endpoints,
    parseError: false,
  };
}

export function resolveNgrokAuthTokenInput(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  const direct = parseAuthtokenFromLine(trimmed);
  if (direct) {
    return direct;
  }

  if (!trimmed.includes('\n') && !trimmed.includes('\r') && !trimmed.toLowerCase().includes('authtoken:')) {
    return trimmed;
  }

  const lines = trimmed.split(/\r?\n/);
  for (const line of lines) {
    const parsed = parseAuthtokenFromLine(line);
    if (parsed) {
      return parsed;
    }
  }

  return '';
}

export async function resolveNgrokAuthTokenFromConfigCheck(ngrokPath) {
  const binaryPath = typeof ngrokPath === 'string' && ngrokPath.trim().length > 0
    ? ngrokPath.trim()
    : 'ngrok';

  let checkResult;
  try {
    checkResult = spawnSync(binaryPath, ['config', 'check'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    return {
      token: '',
      configPath: '',
      detail: `Unable to run 'ngrok config check': ${error.message}`,
    };
  }

  const output = `${checkResult.stdout || ''}${checkResult.stderr || ''}`.trim();
  const configPath = extractConfigPathFromOutput(output);
  if (!configPath) {
    return {
      token: '',
      configPath: '',
      detail: output || "Could not determine ngrok config path from 'ngrok config check'.",
    };
  }

  let configRaw = '';
  try {
    configRaw = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    return {
      token: '',
      configPath,
      detail: `Config file not readable at ${configPath}: ${error.message}`,
    };
  }

  const token = resolveNgrokAuthTokenInput(configRaw);
  if (token && !token.toLowerCase().includes('authtoken:')) {
    return {
      token,
      configPath,
      detail: `Ngrok auth token loaded from ${configPath}.`,
    };
  }

  return {
    token: '',
    configPath,
    detail: `No authtoken found in ${configPath}.`,
  };
}

export async function resolveNgrokConfigValues({ ngrokPath, configPath } = {}) {
  const explicitConfigPath = typeof configPath === 'string' && configPath.trim().length > 0
    ? configPath.trim()
    : '';

  let resolvedConfigPath = explicitConfigPath;
  let fromConfigCheckDetail = '';
  if (!resolvedConfigPath) {
    const tokenLookup = await resolveNgrokAuthTokenFromConfigCheck(ngrokPath);
    resolvedConfigPath = tokenLookup.configPath;
    fromConfigCheckDetail = tokenLookup.detail || '';
  }

  if (!resolvedConfigPath) {
    return {
      configPath: '',
      token: '',
      endpoints: [],
      detail: fromConfigCheckDetail || "Could not determine ngrok config path.",
      parseError: false,
    };
  }

  let configRaw = '';
  try {
    configRaw = fs.readFileSync(resolvedConfigPath, 'utf8');
  } catch (error) {
    return {
      configPath: resolvedConfigPath,
      token: '',
      endpoints: [],
      detail: `Config file not readable at ${resolvedConfigPath}: ${error.message}`,
      parseError: false,
    };
  }

  const parsed = readNgrokConfigValues(configRaw);
  return {
    configPath: resolvedConfigPath,
    token: parsed.token,
    endpoints: parsed.endpoints,
    parseError: parsed.parseError,
    detail: parsed.parseError
      ? `Config file at ${resolvedConfigPath} could not be parsed as YAML.`
      : `Loaded ngrok config at ${resolvedConfigPath}.`,
  };
}

export async function checkNgrokAvailable() {
  const ngrokPath = await searchPathFor('ngrok');
  if (!ngrokPath) {
    return {
      available: false,
      path: null,
      version: null,
    };
  }

  try {
    const result = spawnSync(ngrokPath, ['version'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (result.status === 0) {
      const version = `${result.stdout || ''}${result.stderr || ''}`.trim();
      return {
        available: true,
        path: ngrokPath,
        version,
      };
    }
  } catch {
    // ignore and return unavailable
  }

  return {
    available: false,
    path: ngrokPath,
    version: null,
  };
}

function createNgrokProcess({ args, authToken, binaryPath }) {
  return spawn(binaryPath || 'ngrok', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      NGROK_AUTHTOKEN: authToken,
    },
    killSignal: 'SIGINT',
  });
}

async function startNgrokHttpTunnel({
  authToken,
  originUrl,
  domain,
  edgeId,
  timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  mode,
}) {
  const availability = await checkNgrokAvailable();
  if (!availability.available) {
    throw new Error('ngrok is not installed. Install it with: brew install ngrok/ngrok/ngrok');
  }

  if (typeof originUrl !== 'string' || originUrl.trim().length === 0) {
    throw new Error('originUrl is required for ngrok tunnel startup');
  }

  const token = typeof authToken === 'string' ? authToken.trim() : '';
  if (!token) {
    throw new Error('ngrok auth token is required');
  }

  const args = ['http', originUrl, '--log', 'stdout', '--log-format', 'json'];
  if (typeof domain === 'string' && domain.trim().length > 0) {
    args.push('--domain', domain.trim());
  }
  if (typeof edgeId === 'string' && edgeId.trim().length > 0) {
    args.push('--url', edgeId.trim());
  }

  const proc = createNgrokProcess({
    args,
    authToken: token,
    binaryPath: availability.path || 'ngrok',
  });

  let publicUrl = null;
  let startupError = null;
  let started = false;
  let stdoutBuffer = '';
  let stderrBuffer = '';

  const registerChunk = (chunk) => {
    const text = chunk.toString();
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      const candidateUrl = parseLogLineCandidateUrl(trimmed);
      if (candidateUrl) {
        publicUrl = candidateUrl;
      }

      if (isReadyLogLine(trimmed)) {
        started = true;
      }

      if (isFatalLogLine(trimmed)) {
        startupError = trimmed;
      }
    }
  };

  proc.stdout?.on('data', (chunk) => {
    stdoutBuffer += chunk.toString();
    registerChunk(chunk);
  });
  proc.stderr?.on('data', (chunk) => {
    stderrBuffer += chunk.toString();
    registerChunk(chunk);
  });

  await new Promise((resolve, reject) => {
    let settled = false;

    const finish = (handler, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(readinessInterval);
      clearTimeout(timeout);
      handler(value);
    };

    const timeout = setTimeout(() => {
      if (!settled) {
        proc.kill('SIGTERM');
      }
      finish(reject, new Error(`ngrok tunnel startup timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    const readinessInterval = setInterval(() => {
      if (startupError) {
        if (!settled) {
          proc.kill('SIGTERM');
        }
        finish(reject, new Error(startupError));
        return;
      }
      if (publicUrl && started) {
        finish(resolve);
      }
    }, 100);

    proc.once('error', (error) => {
      finish(reject, error);
    });

    proc.once('exit', (code, signal) => {
      if (settled) {
        return;
      }
      const details = `${stdoutBuffer}\n${stderrBuffer}`.trim();
      const reason = startupError
        || details
        || `ngrok exited during startup (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
      finish(reject, new Error(reason));
    });
  });

  return {
    mode,
    reservedDomain: typeof domain === 'string' && domain.trim().length > 0 ? domain.trim().toLowerCase() : null,
    edgeId: typeof edgeId === 'string' && edgeId.trim().length > 0 ? edgeId.trim() : null,
    stop: () => {
      if (!proc.killed) {
        proc.kill('SIGTERM');
      }
    },
    getPublicUrl: () => publicUrl,
  };
}

export function startNgrokEphemeralTunnel({ authToken, originUrl }) {
  return startNgrokHttpTunnel({
    authToken,
    originUrl,
    mode: 'ephemeral',
  });
}

export function startNgrokReservedTunnel({ authToken, originUrl, reservedDomain }) {
  return startNgrokHttpTunnel({
    authToken,
    originUrl,
    domain: reservedDomain,
    mode: 'reserved',
  });
}

export function startNgrokEdgeTunnel({ authToken, originUrl, edgeId }) {
  return startNgrokHttpTunnel({
    authToken,
    originUrl,
    edgeId,
    mode: 'edge',
  });
}
