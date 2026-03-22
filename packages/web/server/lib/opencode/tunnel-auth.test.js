import { describe, expect, it } from 'bun:test';

import { createTunnelAuth } from './tunnel-auth.js';

const makeReq = ({ hostname, hostHeader, remoteAddress, forwardedFor } = {}) => ({
  hostname,
  headers: {
    host: hostHeader,
    ...(typeof forwardedFor === 'string' ? { 'x-forwarded-for': forwardedFor } : {}),
  },
  socket: {
    remoteAddress,
  },
});

describe('tunnel auth request scope classification', () => {
  it('keeps localhost requests as local', () => {
    const auth = createTunnelAuth();
    const req = makeReq({
      hostname: 'localhost',
      hostHeader: 'localhost:3000',
      remoteAddress: '127.0.0.1',
    });

    expect(auth.classifyRequestScope(req)).toBe('local');
  });

  it('treats host.docker.internal as local from private socket IP', () => {
    const auth = createTunnelAuth();
    const req = makeReq({
      hostname: 'host.docker.internal',
      hostHeader: 'host.docker.internal:3000',
      remoteAddress: '172.22.0.1',
    });

    expect(auth.classifyRequestScope(req)).toBe('local');
  });

  it('does not treat host.docker.internal as local from public socket IP', () => {
    const auth = createTunnelAuth();
    auth.setActiveTunnel({ tunnelId: 't1', publicUrl: 'https://example.trycloudflare.com' });

    const req = makeReq({
      hostname: 'host.docker.internal',
      hostHeader: 'host.docker.internal:3000',
      remoteAddress: '8.8.8.8',
    });

    expect(auth.classifyRequestScope(req)).toBe('unknown-public');
  });

  it('does not trust x-forwarded-for for host.docker.internal classification', () => {
    const auth = createTunnelAuth();
    auth.setActiveTunnel({ tunnelId: 't1', publicUrl: 'https://example.trycloudflare.com' });

    const req = makeReq({
      hostname: 'host.docker.internal',
      hostHeader: 'host.docker.internal:3000',
      remoteAddress: '8.8.4.4',
      forwardedFor: '127.0.0.1',
    });

    expect(auth.classifyRequestScope(req)).toBe('unknown-public');
  });

  it('keeps active tunnel host classified as tunnel', () => {
    const auth = createTunnelAuth();
    auth.setActiveTunnel({ tunnelId: 't1', publicUrl: 'https://host.docker.internal' });

    const req = makeReq({
      hostname: 'host.docker.internal',
      hostHeader: 'host.docker.internal',
      remoteAddress: '172.22.0.1',
    });

    expect(auth.classifyRequestScope(req)).toBe('tunnel');
  });
});
