import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPortInUse, probeDshUrl } from '../http';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('probeDshUrl', () => {
  it('identifies a reachable DSH shell', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('<script>window.__DSH_BOOT__ = {}</script>', { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(probeDshUrl('http://127.0.0.1:3080', 1000)).resolves.toMatchObject({
      reachable: true,
      isDsh: true,
      status: 200,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3080',
      expect.objectContaining({ redirect: 'manual' })
    );
  });

  it('distinguishes a reachable non-DSH response even for non-2xx status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<h1>not DSH</h1>', { status: 404 })));
    await expect(probeDshUrl('http://127.0.0.1:3080', 1000)).resolves.toMatchObject({
      reachable: true,
      isDsh: false,
      status: 404,
    });
  });

  it('reports a transport failure without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('connection refused'))));
    await expect(probeDshUrl('http://127.0.0.1:3080', 1000)).resolves.toMatchObject({
      reachable: false,
      isDsh: false,
      error: 'connection refused',
    });
  });

  it('rejects oversized responses before reading them', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('ignored', { status: 200, headers: { 'content-length': String(1024 * 1024) } })
      )
    );
    await expect(probeDshUrl('http://127.0.0.1:3080', 1000)).resolves.toMatchObject({
      reachable: true,
      isDsh: false,
      error: 'Response too large',
    });
  });

  it('stops reading a chunked response once the real body exceeds the cap', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(300 * 1024));
        controller.enqueue(new Uint8Array(300 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { status: 200 })));

    await expect(probeDshUrl('http://127.0.0.1:3080', 1000)).resolves.toMatchObject({
      reachable: true,
      isDsh: false,
      error: 'Response too large',
    });
    expect(cancelled).toBe(true);
  });

  it('rejects non-loopback targets without making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(probeDshUrl('http://example.com:3080', 1000)).resolves.toMatchObject({
      reachable: false,
      isDsh: false,
      error: expect.stringMatching(/local HTTP/),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not fetch when the operation was already cancelled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();
    await expect(probeDshUrl('http://127.0.0.1:3080', 1000, controller.signal)).resolves.toMatchObject({
      reachable: false,
      error: 'Operation cancelled',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not create a socket for an already-cancelled port check', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(isPortInUse(3080, 1000, controller.signal)).resolves.toBe(false);
  });
});
