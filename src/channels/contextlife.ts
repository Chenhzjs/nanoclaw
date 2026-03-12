/**
 * ContextLife Channel for NanoClaw
 *
 * Connects NanoClaw to the ContextLife Claw Hub — a pseudo group chat where
 * AIRI can @mention different claw bots to delegate tasks.
 *
 * Works exactly like the Telegram/Discord/Slack channels: this file implements
 * the Channel interface and self-registers via registerChannel().
 *
 * Environment variables:
 *   CONTEXTLIFE_HUB_URL  - Hub base URL (default: http://localhost:5001)
 *   CONTEXTLIFE_BOT_NAME - Bot name to register as (default: nanoclaw)
 */

import { registerChannel, type ChannelOpts } from './registry.js';
import type {
  Channel,
  NewMessage,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';
import { ASSISTANT_NAME, POLL_INTERVAL } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';

// ── Configuration ─────────────────────────────────────────────────────────

const envConfig = readEnvFile(['CONTEXTLIFE_HUB_URL', 'CONTEXTLIFE_BOT_NAME']);

const HUB_URL =
  process.env.CONTEXTLIFE_HUB_URL ||
  envConfig.CONTEXTLIFE_HUB_URL ||
  'http://localhost:5001';

const BOT_NAME = (
  process.env.CONTEXTLIFE_BOT_NAME ||
  envConfig.CONTEXTLIFE_BOT_NAME ||
  'nanoclaw'
).toLowerCase();

// JID suffix — all JIDs from this channel end with @contextlife
const JID_SUFFIX = '@contextlife';

// The "group chat" JID
const GROUP_JID = `hub${JID_SUFFIX}`;

// ── HTTP helpers ──────────────────────────────────────────────────────────

async function hubFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const url = `${HUB_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  return res;
}

async function hubPost(path: string, body: Record<string, unknown>) {
  const res = await hubFetch(path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return res.json() as Promise<Record<string, unknown>>;
}

async function hubGet(path: string, params: Record<string, string> = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = qs ? `${path}?${qs}` : path;
  const res = await hubFetch(url);
  return res.json() as Promise<Record<string, unknown>>;
}

// ── Channel implementation ────────────────────────────────────────────────

class ContextLifeChannel implements Channel {
  name = 'contextlife';

  private connected = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private onMessage: OnInboundMessage;
  private onChatMetadata: OnChatMetadata;
  private registeredGroups: () => Record<string, RegisteredGroup>;
  private registerGroup?: (jid: string, group: RegisteredGroup) => void;

  constructor(opts: ChannelOpts) {
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
    this.registeredGroups = opts.registeredGroups;
    this.registerGroup = opts.registerGroup;
  }

  async connect(): Promise<void> {
    // Register chat metadata eagerly so the group is discoverable
    this.onChatMetadata(
      GROUP_JID,
      new Date().toISOString(),
      'Claw Hub',
      'contextlife',
      true, // is_group
    );

    // Auto-register the Claw Hub group so messages are actually processed
    if (this.registerGroup && !this.registeredGroups()[GROUP_JID]) {
      this.registerGroup(GROUP_JID, {
        name: 'Claw Hub',
        folder: 'claw-hub',
        trigger: `@${BOT_NAME}`,
        added_at: new Date().toISOString(),
        requiresTrigger: false, // Hub already filters by @mention — every delivered message is for us
      });
      logger.info({ jid: GROUP_JID }, 'Auto-registered Claw Hub group');
    }

    // Try initial registration — if Hub is offline, keep polling until it appears
    await this.tryRegister();

    // Start polling for messages (also re-registers if connection was lost)
    this.pollTimer = setInterval(() => {
      this.pollMessages().catch((err) =>
        logger.debug({ err }, 'ContextLife poll cycle error'),
      );
    }, POLL_INTERVAL);

    logger.info(
      { hub: HUB_URL, bot: BOT_NAME },
      'ContextLife channel started (will connect when Hub is available)',
    );
  }

  private async tryRegister(): Promise<void> {
    try {
      const result = await hubPost('/api/claw-hub/register', {
        name: BOT_NAME,
        display_name: ASSISTANT_NAME,
        capabilities: ['code', 'agent', 'container'],
      });

      if (result.ok) {
        if (!this.connected) {
          logger.info({ hub: HUB_URL, bot: BOT_NAME }, 'ContextLife channel connected');
        }
        this.connected = true;
      }
    } catch {
      if (this.connected) {
        logger.warn({ hub: HUB_URL }, 'ContextLife Hub went offline');
      }
      this.connected = false;
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) return;

    try {
      await hubPost('/api/claw-hub/send', {
        from: BOT_NAME,
        content: text,
        type: 'response',
      });
    } catch (err) {
      logger.error({ err, jid }, 'Failed to send message to ContextLife Hub');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith(JID_SUFFIX);
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.connected) {
      try {
        await hubPost('/api/claw-hub/unregister', { name: BOT_NAME });
      } catch {
        // Ignore errors during shutdown
      }
    }

    this.connected = false;
    logger.info('ContextLife channel disconnected');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.connected) return;

    try {
      await hubPost('/api/claw-hub/typing', {
        bot: BOT_NAME,
        typing: isTyping,
      });
    } catch {
      // Non-critical, ignore errors
    }
  }

  // ── Private ───────────────────────────────────────────────────────────

  private async pollMessages(): Promise<void> {
    // If not connected, try to register (auto-reconnect when Hub comes online)
    if (!this.connected) {
      await this.tryRegister();
      if (!this.connected) return;
    }

    try {
      const data = await hubGet('/api/claw-hub/messages', { bot: BOT_NAME });
      const messages = (data.messages || []) as Array<{
        id: string;
        from: string;
        content: string;
        timestamp: string;
        type: string;
        mentions: string[];
      }>;

      for (const msg of messages) {
        // Skip system messages and our own messages
        if (msg.type === 'system' || msg.from === BOT_NAME) continue;

        const newMsg: NewMessage = {
          id: msg.id,
          chat_jid: GROUP_JID,
          sender: `${msg.from}${JID_SUFFIX}`,
          sender_name: msg.from,
          content: msg.content,
          timestamp: msg.timestamp || new Date().toISOString(),
          is_from_me: false,
          is_bot_message: false,
        };

        // Update chat metadata timestamp
        this.onChatMetadata(
          GROUP_JID,
          newMsg.timestamp,
          'Claw Hub',
          'contextlife',
          true,
        );

        // Deliver message
        this.onMessage(GROUP_JID, newMsg);
      }
    } catch (err) {
      // Connection lost — mark as disconnected, will auto-reconnect next poll
      if (this.connected) {
        logger.warn({ err }, 'ContextLife Hub connection lost (will auto-reconnect)');
        this.connected = false;
      }
    }
  }
}

// ── Self-registration ─────────────────────────────────────────────────────

registerChannel('contextlife', (opts: ChannelOpts) => {
  // Always create the channel — the Hub URL is localhost by default
  // The channel will fail on connect() if the Hub is not running
  return new ContextLifeChannel(opts);
});
