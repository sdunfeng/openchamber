import express from 'express';

export const registerOpenCodeProxy = (app, deps) => {
  const {
    fs,
    os,
    path,
    OPEN_CODE_READY_GRACE_MS,
    LONG_REQUEST_TIMEOUT_MS,
    getRuntime,
    getOpenCodeAuthHeaders,
    buildOpenCodeUrl,
    ensureOpenCodeApiPrefix,
    getUiNotificationClients,
  } = deps;

  if (app.get('opencodeProxyConfigured')) {
    return;
  }

  const runtime = getRuntime();
  if (runtime.openCodePort) {
    console.log(`Setting up proxy to OpenCode on port ${runtime.openCodePort}`);
  } else {
    console.log('Setting up OpenCode API gate (OpenCode not started yet)');
  }
  app.set('opencodeProxyConfigured', true);

  const stripApiPrefix = (rawUrl) => {
    if (typeof rawUrl !== 'string' || !rawUrl) {
      return '/';
    }
    if (rawUrl === '/api') {
      return '/';
    }
    if (rawUrl.startsWith('/api/')) {
      return rawUrl.slice(4);
    }
    return rawUrl;
  };

  const rewriteWindowsDirectoryParam = (upstreamPath) => {
    if (process.platform !== 'win32') {
      return upstreamPath;
    }
    try {
      const parsed = new URL(upstreamPath, 'http://openchamber.local');
      const pathname = parsed.pathname || '/';
      if (pathname === '/session' || pathname.startsWith('/session/')) {
        return upstreamPath;
      }
      const directory = parsed.searchParams.get('directory');
      if (!directory || !directory.includes('/')) {
        return upstreamPath;
      }
      const fixed = directory.replace(/\//g, '\\');
      parsed.searchParams.set('directory', fixed);
      const rewritten = `${parsed.pathname}${parsed.search}${parsed.hash}`;
      if (rewritten !== upstreamPath) {
        console.log(`[Win32PathFix] Rewrote directory: "${directory}" -> "${fixed}"`);
        console.log(`[Win32PathFix] URL: "${upstreamPath}" -> "${rewritten}"`);
      }
      return rewritten;
    } catch {
      return upstreamPath;
    }
  };

  const getUpstreamPathForRequest = (req) => {
    const rawUrl = (typeof req.originalUrl === 'string' && req.originalUrl)
      ? req.originalUrl
      : (typeof req.url === 'string' ? req.url : '/');
    return rewriteWindowsDirectoryParam(stripApiPrefix(rawUrl));
  };

  const isSseApiPath = (value) => value === '/event' || value === '/global/event';

  const forwardSseRequest = async (req, res, options = {}) => {
    const startedAt = Date.now();
    const {
      upstreamPath: explicitUpstreamPath,
      directory = null,
      registerUiClient = false,
    } = options;
    const upstreamPath = explicitUpstreamPath || getUpstreamPathForRequest(req);
    const targetUrl = new URL(buildOpenCodeUrl(upstreamPath, ''));
    if (typeof directory === 'string' && directory.trim().length > 0) {
      targetUrl.searchParams.set('directory', directory.trim());
    }
    const authHeaders = getOpenCodeAuthHeaders();

    const requestHeaders = {
      ...(typeof req.headers.accept === 'string' ? { accept: req.headers.accept } : { accept: 'text/event-stream' }),
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...(authHeaders.Authorization ? { Authorization: authHeaders.Authorization } : {}),
    };

    const lastEventId = req.header('Last-Event-ID');
    if (typeof lastEventId === 'string' && lastEventId.length > 0) {
      requestHeaders['Last-Event-ID'] = lastEventId;
    }

    const controller = new AbortController();
    let connectTimer = null;
    let idleTimer = null;
    let heartbeatTimer = null;
    let endedBy = 'upstream-end';

    const cleanup = () => {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (registerUiClient) {
        getUiNotificationClients().delete(res);
      }
      req.off('close', onClientClose);
      req.off('error', onClientClose);
    };

    const resetIdleTimeout = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => {
        endedBy = 'idle-timeout';
        controller.abort();
      }, 5 * 60 * 1000);
    };

    const onClientClose = () => {
      endedBy = 'client-disconnect';
      controller.abort();
    };

    req.on('close', onClientClose);
    req.on('error', onClientClose);

    try {
      connectTimer = setTimeout(() => {
        endedBy = 'connect-timeout';
        controller.abort();
      }, 10 * 1000);

      const upstreamResponse = await fetch(targetUrl, {
        method: 'GET',
        headers: requestHeaders,
        signal: controller.signal,
      });

      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }

      if (!upstreamResponse.ok || !upstreamResponse.body) {
        const body = await upstreamResponse.text().catch(() => '');
        cleanup();
        if (!res.headersSent) {
          if (upstreamResponse.headers.has('content-type')) {
            res.setHeader('content-type', upstreamResponse.headers.get('content-type'));
          }
          res.status(upstreamResponse.status).send(body);
        }
        return;
      }

      const upstreamContentType = upstreamResponse.headers.get('content-type') || 'text/event-stream';
      res.status(upstreamResponse.status);
      res.setHeader('content-type', upstreamContentType);
      res.setHeader('cache-control', 'no-cache');
      res.setHeader('connection', 'keep-alive');
      res.setHeader('x-accel-buffering', 'no');
      res.setHeader('x-content-type-options', 'nosniff');
      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
      }

      if (registerUiClient) {
        getUiNotificationClients().add(res);
      }

      resetIdleTimeout();
      heartbeatTimer = setInterval(() => {
        if (res.writableEnded || controller.signal.aborted) {
          return;
        }
        try {
          res.write(': ping\n\n');
          resetIdleTimeout();
        } catch {
        }
      }, 30 * 1000);

      const reader = upstreamResponse.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            endedBy = endedBy === 'upstream-end' ? 'upstream-finished' : endedBy;
            break;
          }
          if (controller.signal.aborted) {
            break;
          }
          if (value && value.length > 0) {
            res.write(Buffer.from(value));
            resetIdleTimeout();
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
        }
      }

      cleanup();
      if (!res.writableEnded) {
        res.end();
      }
      console.log(`SSE forward ${upstreamPath} closed (${endedBy}) in ${Date.now() - startedAt}ms`);
    } catch (error) {
      cleanup();
      const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      if (!res.headersSent) {
        res.status(isTimeout ? 504 : 503).json({
          error: isTimeout ? 'OpenCode SSE forward timed out' : 'OpenCode SSE forward failed',
        });
      } else if (!res.writableEnded) {
        res.end();
      }
      console.warn(`SSE forward ${upstreamPath} failed (${endedBy}):`, error?.message || error);
    }
  };

  app.get('/api/global/event', async (req, res) => {
    await forwardSseRequest(req, res, {
      upstreamPath: '/global/event',
      registerUiClient: true,
    });
  });

  app.get('/api/event', async (req, res) => {
    const headerDirectory = typeof req.get === 'function' ? req.get('x-opencode-directory') : null;
    const directoryParam = Array.isArray(req.query.directory)
      ? req.query.directory[0]
      : req.query.directory;
    const resolvedDirectory = headerDirectory || directoryParam || null;

    await forwardSseRequest(req, res, {
      upstreamPath: '/event',
      directory: typeof resolvedDirectory === 'string' ? resolvedDirectory : null,
    });
  });

  app.use('/api', (_req, _res, next) => {
    ensureOpenCodeApiPrefix();
    next();
  });

  app.use('/api', (req, res, next) => {
    if (
      req.path.startsWith('/themes/custom') ||
      req.path.startsWith('/config/agents') ||
      req.path.startsWith('/config/opencode-resolution') ||
      req.path.startsWith('/config/settings') ||
      req.path.startsWith('/config/skills') ||
      req.path === '/health'
    ) {
      return next();
    }
    console.log(`API -> OpenCode: ${req.method} ${req.path}`);
    next();
  });

  const hopByHopRequestHeaders = new Set([
    'host',
    'connection',
    'content-length',
    'transfer-encoding',
    'keep-alive',
    'te',
    'trailer',
    'upgrade',
  ]);

  const hopByHopResponseHeaders = new Set([
    'connection',
    'content-length',
    'transfer-encoding',
    'keep-alive',
    'te',
    'trailer',
    'upgrade',
    'www-authenticate',
  ]);

  const collectForwardHeaders = (req) => {
    const authHeaders = getOpenCodeAuthHeaders();
    const headers = {};

    for (const [key, value] of Object.entries(req.headers || {})) {
      if (!value) continue;
      const lowerKey = key.toLowerCase();
      if (hopByHopRequestHeaders.has(lowerKey)) continue;
      headers[lowerKey] = Array.isArray(value) ? value.join(', ') : String(value);
    }

    if (authHeaders.Authorization) {
      headers.Authorization = authHeaders.Authorization;
    }

    return headers;
  };

  const collectRequestBodyBuffer = async (req) => {
    if (Buffer.isBuffer(req.body)) {
      return req.body;
    }

    if (typeof req.body === 'string') {
      return Buffer.from(req.body);
    }

    if (req.body && typeof req.body === 'object') {
      return Buffer.from(JSON.stringify(req.body));
    }

    if (req.readableEnded) {
      return Buffer.alloc(0);
    }

    return await new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  };

  const forwardGenericApiRequest = async (req, res) => {
    try {
      const upstreamPath = getUpstreamPathForRequest(req);
      const targetUrl = buildOpenCodeUrl(upstreamPath, '');
      const headers = collectForwardHeaders(req);
      const method = String(req.method || 'GET').toUpperCase();
      const hasBody = method !== 'GET' && method !== 'HEAD';
      const bodyBuffer = hasBody ? await collectRequestBodyBuffer(req) : null;

      const upstreamResponse = await fetch(targetUrl, {
        method,
        headers,
        body: hasBody ? bodyBuffer : undefined,
        signal: AbortSignal.timeout(LONG_REQUEST_TIMEOUT_MS),
      });

      for (const [key, value] of upstreamResponse.headers.entries()) {
        const lowerKey = key.toLowerCase();
        if (hopByHopResponseHeaders.has(lowerKey)) {
          continue;
        }
        res.setHeader(key, value);
      }

      const upstreamBody = Buffer.from(await upstreamResponse.arrayBuffer());
      res.status(upstreamResponse.status).send(upstreamBody);
    } catch (error) {
      if (!res.headersSent) {
        const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        res.status(isTimeout ? 504 : 503).json({
          error: isTimeout ? 'OpenCode request timed out' : 'OpenCode service unavailable',
        });
      }
    }
  };

  app.post('/api/session/:sessionId/message', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
    try {
      const upstreamPath = getUpstreamPathForRequest(req);
      const targetUrl = buildOpenCodeUrl(upstreamPath, '');
      const authHeaders = getOpenCodeAuthHeaders();

      const headers = {
        ...(typeof req.headers['content-type'] === 'string' ? { 'content-type': req.headers['content-type'] } : { 'content-type': 'application/json' }),
        ...(typeof req.headers.accept === 'string' ? { accept: req.headers.accept } : {}),
        ...(authHeaders.Authorization ? { Authorization: authHeaders.Authorization } : {}),
      };

      const bodyBuffer = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(typeof req.body === 'string' ? req.body : '');

      const upstreamResponse = await fetch(targetUrl, {
        method: 'POST',
        headers,
        body: bodyBuffer,
        signal: AbortSignal.timeout(LONG_REQUEST_TIMEOUT_MS),
      });

      const upstreamBody = Buffer.from(await upstreamResponse.arrayBuffer());

      if (upstreamResponse.headers.has('content-type')) {
        res.setHeader('content-type', upstreamResponse.headers.get('content-type'));
      }

      res.status(upstreamResponse.status).send(upstreamBody);
    } catch (error) {
      if (!res.headersSent) {
        const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        res.status(isTimeout ? 504 : 503).json({
          error: isTimeout ? 'OpenCode message forward timed out' : 'OpenCode message forward failed',
        });
      }
    }
  });

  app.use('/api', async (req, res, next) => {
    if (isSseApiPath(req.path)) {
      return next();
    }

    if (req.method === 'POST' && /\/session\/[^/]+\/message$/.test(req.path || '')) {
      return next();
    }

    if (process.platform === 'win32' && req.method === 'GET' && req.path === '/session') {
      const rawUrl = req.originalUrl || req.url || '';
      if (!rawUrl.includes('directory=')) {
        try {
          const authHeaders = getOpenCodeAuthHeaders();
          const fetchOpts = {
            method: 'GET',
            headers: { Accept: 'application/json', ...authHeaders },
            signal: AbortSignal.timeout(10000),
          };
          const globalRes = await fetch(buildOpenCodeUrl('/session', ''), fetchOpts);
          const globalPayload = globalRes.ok ? await globalRes.json().catch(() => []) : [];
          const globalSessions = Array.isArray(globalPayload) ? globalPayload : [];

          const settingsPath = path.join(os.homedir(), '.config', 'openchamber', 'settings.json');
          let projectDirs = [];
          try {
            const settingsRaw = fs.readFileSync(settingsPath, 'utf8');
            const settings = JSON.parse(settingsRaw);
            projectDirs = (settings.projects || [])
              .map((project) => (typeof project?.path === 'string' ? project.path.trim() : ''))
              .filter(Boolean);
          } catch {
          }

          const seen = new Set(
            globalSessions
              .map((session) => (session && typeof session.id === 'string' ? session.id : null))
              .filter((id) => typeof id === 'string')
          );
          const extraSessions = [];
          for (const dir of projectDirs) {
            const candidates = Array.from(new Set([
              dir,
              dir.replace(/\\/g, '/'),
              dir.replace(/\//g, '\\'),
            ]));
            for (const candidateDir of candidates) {
              const encoded = encodeURIComponent(candidateDir);
              try {
                const dirRes = await fetch(buildOpenCodeUrl(`/session?directory=${encoded}`, ''), fetchOpts);
                if (dirRes.ok) {
                  const dirPayload = await dirRes.json().catch(() => []);
                  const dirSessions = Array.isArray(dirPayload) ? dirPayload : [];
                  for (const session of dirSessions) {
                    const id = session && typeof session.id === 'string' ? session.id : null;
                    if (id && !seen.has(id)) {
                      seen.add(id);
                      extraSessions.push(session);
                    }
                  }
                }
              } catch {
              }
            }
          }

          const merged = [...globalSessions, ...extraSessions];
          merged.sort((a, b) => {
            const aTime = a && typeof a.time_updated === 'number' ? a.time_updated : 0;
            const bTime = b && typeof b.time_updated === 'number' ? b.time_updated : 0;
            return bTime - aTime;
          });
          console.log(`[SessionMerge] ${globalSessions.length} global + ${extraSessions.length} extra = ${merged.length} total`);
          return res.json(merged);
        } catch (error) {
          console.log(`[SessionMerge] Error: ${error.message}, falling through`);
        }
      }
    }

    return forwardGenericApiRequest(req, res);
  });

  app.use('/api', (req, res, next) => {
    if (
      req.path.startsWith('/themes/custom') ||
      req.path.startsWith('/push') ||
      req.path.startsWith('/config/agents') ||
      req.path.startsWith('/config/opencode-resolution') ||
      req.path.startsWith('/config/settings') ||
      req.path.startsWith('/config/skills') ||
      req.path === '/config/reload' ||
      req.path === '/health'
    ) {
      return next();
    }

    const runtimeState = getRuntime();
    const waitElapsed = runtimeState.openCodeNotReadySince === 0 ? 0 : Date.now() - runtimeState.openCodeNotReadySince;
    const stillWaiting =
      (!runtimeState.isOpenCodeReady && (runtimeState.openCodeNotReadySince === 0 || waitElapsed < OPEN_CODE_READY_GRACE_MS)) ||
      runtimeState.isRestartingOpenCode ||
      !runtimeState.openCodePort;

    if (stillWaiting) {
      return res.status(503).json({
        error: 'OpenCode is restarting',
        restarting: true,
      });
    }

    next();
  });
};
