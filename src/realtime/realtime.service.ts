import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { config } from '../config';
import { RedisService } from '../redis/redis.service';

export interface FlagChangeEvent {
  flag_key: string;
  action: string;
  environment: string;
  at: string;
}

type Listener = (event: FlagChangeEvent) => void;

/**
 * Real-time flag-change fanout (bonus feature, PLAN §4).
 *
 * Publishes on Redis pub/sub channels `flags:{tenantId}:{environment}` and
 * pattern-subscribes once per instance. Pub/sub — not local EventEmitter —
 * because Cloud Run runs multiple instances: a toggle handled by instance A
 * must reach an SSE client attached to instance B.
 */
@Injectable()
export class RealtimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeService.name);
  /** Dedicated connection: ioredis clients in subscriber mode cannot issue commands. */
  private subscriber?: Redis;
  private listeners = new Map<string, Set<Listener>>();

  constructor(private readonly redis: RedisService) {}

  onModuleInit() {
    // enableOfflineQueue must be re-enabled here: the main client disables it
    // (fail-fast cache ops), but the subscriber issues psubscribe immediately
    // on boot, before the connection is ready — it must queue, not throw.
    this.subscriber = this.redis.client.duplicate({ enableOfflineQueue: true });
    this.subscriber.on('error', (err) => this.logger.warn(`subscriber error: ${err.message}`));
    this.subscriber.psubscribe('flags:*').catch((err) => {
      this.logger.warn(`psubscribe failed: ${err.message}`);
    });
    this.subscriber.on('pmessage', (_pattern, channel, message) => {
      const handlers = this.listeners.get(channel);
      if (!handlers?.size) return;
      try {
        const event = JSON.parse(message) as FlagChangeEvent;
        for (const handler of handlers) handler(event);
      } catch {
        /* malformed message — drop */
      }
    });
  }

  async onModuleDestroy() {
    await this.subscriber?.quit().catch(() => this.subscriber?.disconnect());
  }

  private channel(tenantId: string, environment: string): string {
    return `flags:${tenantId}:${environment}`;
  }

  async publish(
    tenantId: string,
    environments: string[],
    event: Omit<FlagChangeEvent, 'environment' | 'at'>,
  ): Promise<void> {
    const at = new Date().toISOString();
    try {
      for (const environment of environments) {
        await this.redis.client.publish(
          this.channel(tenantId, environment),
          JSON.stringify({ ...event, environment, at }),
        );
      }
    } catch {
      // Degraded mode: realtime is best-effort, mutations must never fail
      // because pub/sub is down.
    }
  }

  subscribe(tenantId: string, environment: string, listener: Listener): () => void {
    const channel = this.channel(tenantId, environment);
    if (!this.listeners.has(channel)) this.listeners.set(channel, new Set());
    this.listeners.get(channel)!.add(listener);
    return () => {
      const set = this.listeners.get(channel);
      set?.delete(listener);
      if (set?.size === 0) this.listeners.delete(channel);
    };
  }
}

export const SSE_HEARTBEAT_MS = config.env === 'test' ? 1000 : 25_000;
