import { describe, expect, it } from 'vitest';
import net from 'node:net';

import { findAvailablePort } from '../../src/lifecycle.js';

function occupyPort(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      resolve({ port: address.port, close: () => server.close() });
    });
  });
}

describe('findAvailablePort', () => {
  it('空闲端口直接命中', async () => {
    const free = await occupyPort();
    const port = free.port;
    free.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const selected = await findAvailablePort('127.0.0.1', port, 3);
    expect(selected).toBe(port);
  });

  it('被占用端口自动顺延', async () => {
    const occupied = await occupyPort();
    try {
      const selected = await findAvailablePort('127.0.0.1', occupied.port, 5);
      expect(selected).not.toBe(occupied.port);
      expect(selected).toBe(occupied.port + 1);
    } finally {
      occupied.close();
    }
  });

  it('全部被占用时抛错', async () => {
    const first = await occupyPort();
    const second = await new Promise<{ port: number; close: () => void }>((resolve) => {
      const server = net.createServer();
      server.listen(first.port + 1, '127.0.0.1', () => {
        resolve({ port: first.port + 1, close: () => server.close() });
      });
    });
    try {
      await expect(
        findAvailablePort('127.0.0.1', first.port, 2),
      ).rejects.toThrow(/可用端口/);
    } finally {
      first.close();
      second.close();
    }
  });
});
