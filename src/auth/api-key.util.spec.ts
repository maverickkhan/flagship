import { generateApiKey, hashApiKey, safeEqual } from './api-key.util';

describe('api key utilities', () => {
  it('generates ff_-prefixed keys with 32 bytes of entropy', () => {
    const { key, hash, prefix } = generateApiKey();
    expect(key).toMatch(/^ff_[A-Za-z0-9_-]{43}$/);
    expect(prefix).toBe(key.slice(0, 10));
    expect(hash).toBe(hashApiKey(key));
  });

  it('generates unique keys', () => {
    const keys = new Set(Array.from({ length: 100 }, () => generateApiKey().key));
    expect(keys.size).toBe(100);
  });

  it('hash is stable and hex-encoded sha256', () => {
    expect(hashApiKey('ff_abc')).toBe(hashApiKey('ff_abc'));
    expect(hashApiKey('ff_abc')).toMatch(/^[a-f0-9]{64}$/);
    expect(hashApiKey('ff_abc')).not.toBe(hashApiKey('ff_abd'));
  });

  it('safeEqual compares without length leaks', () => {
    expect(safeEqual('token-a', 'token-a')).toBe(true);
    expect(safeEqual('token-a', 'token-b')).toBe(false);
    expect(safeEqual('short', 'a-much-longer-token')).toBe(false);
  });
});
