const { Client, GatewayIntentBits } = require('discord.js');
const http = require('http');

const PORT = process.env.PORT || 7860;
const VERCEL_URL = process.env.VERCEL_PREFIX_URL || 'https://dc-lwe.vercel.app/api/discord/prefix';
const DROPS_URL = process.env.VERCEL_DROPS_URL || VERCEL_URL.replace('/api/discord/prefix', '/api/cron/drops');
const TOKEN = process.env.DISCORD_TOKEN;
const BRIDGE_SECRET = process.env.BRIDGE_SECRET;

if (!TOKEN) {
  console.error('❌ Missing DISCORD_TOKEN environment variable! Please configure it in your host environment variables.');
}

if (!BRIDGE_SECRET) {
  console.warn('⚠️ Missing BRIDGE_SECRET environment variable! Prefix endpoint requests will be rejected by the server.');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Lightweight HTTP server for Cloud Health Checks & Uptime pings
// Returns 200 with uptime and whether Discord gateway is connected, 503 if not
http.createServer((req, res) => {
  const url = req.url || '/';
  if (url === '/health' || url === '/') {
    const isReady = client.isReady();
    const statusCode = isReady ? 200 : 503;
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: isReady ? 'online' : 'connecting',
        bot: client.user ? client.user.tag : 'connecting',
        gatewayConnected: isReady,
        uptime: Math.round(process.uptime()),
        pingMs: client.ws?.ping ?? -1,
      })
    );
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}).listen(PORT, () => {
  console.log(`📡 Cloud health-check server listening on port ${PORT}`);
});

// Cache guild configuration: prefix & allowed channels (5-minute refresh)
// This ensures non-matching chat messages never hit Vercel
const guildConfigCache = new Map();
const CONFIG_TTL_MS = 5 * 60 * 1000;

async function getGuildConfig(guildId) {
  const cached = guildConfigCache.get(guildId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  try {
    const fetchUrl = `${VERCEL_URL}?guildId=${guildId}`;
    const res = await fetch(fetchUrl, {
      headers: { 'x-bridge-token': BRIDGE_SECRET || '' },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json();
      guildConfigCache.set(guildId, {
        data: {
          prefix: (data.prefix || 'lwe').toLowerCase(),
          allowedChannels: data.allowedChannels || [],
          channelOverrides: data.channelOverrides || {},
        },
        expiresAt: now + CONFIG_TTL_MS,
      });
      return guildConfigCache.get(guildId).data;
    }
  } catch (err) {
    // If fetching fails, fallback to defaults or existing stale cache
    if (cached) return cached.data;
  }

  const fallback = { prefix: 'lwe', allowedChannels: [], channelOverrides: {} };
  guildConfigCache.set(guildId, { data: fallback, expiresAt: now + 60 * 1000 });
  return fallback;
}

// Request forwarder with 4s timeout and 1 retry
async function forwardToVercel(payload, attempt = 1) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);

  try {
    const res = await fetch(VERCEL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bridge-token': BRIDGE_SECRET || '',
        'x-idempotency-key': payload.messageId || '',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${errText}`);
    }

    return await res.json();
  } catch (err) {
    clearTimeout(timeoutId);
    if (attempt < 2) {
      // Retry once after 200ms
      await new Promise((r) => setTimeout(r, 200));
      return forwardToVercel(payload, attempt + 1);
    }
    throw err;
  }
}

client.on('ready', () => {
  console.log(`✅ Lwe Gateway Bridge online as ${client.user.tag}! Forwarding chat commands to ${VERCEL_URL}`);
  client.user.setActivity('lwe help | https://dc-lwe.vercel.app');
});

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot || !message.guild) return;

    const guildId = message.guild.id;
    const channelId = message.channel.id;
    const content = message.content.trim();

    // Fast in-memory check for prefix and allowed channels
    const config = await getGuildConfig(guildId);
    const prefix = config.prefix || 'lwe';
    const lowerContent = content.toLowerCase();
    const isCommand = lowerContent.startsWith(prefix);

    // Fast filter: if channel is restricted and message is not a command, ignore immediately (costs 0 roundtrips)
    const isChannelDenied =
      config.channelOverrides?.[channelId] === 'denied' ||
      (config.allowedChannels.length > 0 && !config.allowedChannels.includes(channelId));

    if (isChannelDenied && !isCommand) {
      return;
    }

    // If message does not start with prefix and does not contain enough text for activity quest, ignore
    if (!isCommand && content.length < 5) {
      return;
    }

    // Compute permissions directly from the real Discord GuildMember
    const memberPermissions = message.member?.permissions
      ? message.member.permissions.bitfield.toString()
      : '0';

    const payload = {
      messageId: message.id,
      guildId,
      channelId,
      userId: message.author.id,
      userTag: message.author.username || message.author.tag,
      memberPermissions,
      content: content.slice(0, 500),
    };

    const t0 = Date.now();
    try {
      const res = await forwardToVercel(payload);
      const elapsed = Date.now() - t0;
      if (isCommand) {
        console.log(`[Bridge] Handled "${content.slice(0, 24)}" in ${elapsed}ms`);
      }

      // Handle serverless scheduled auto-deletion if returned
      if (res?.autoDeleteMessageId && res?.deleteAfterSeconds) {
        setTimeout(async () => {
          try {
            const channel = message.channel;
            const targetMsg = await channel.messages.fetch(res.autoDeleteMessageId).catch(() => null);
            if (targetMsg && targetMsg.deletable) {
              await targetMsg.delete().catch(() => {});
            }
          } catch {}
        }, res.deleteAfterSeconds * 1000);
      }
    } catch (err) {
      const elapsed = Date.now() - t0;
      console.error(`[Bridge Error] Command failed after ${elapsed}ms:`, err.message);

      if (isCommand) {
        // Reply in channel with short error message if server does not respond
        message
          .reply({
            content: '⚠️ | The server did not respond in time. Please try again in a moment!',
          })
          .then((replyMsg) => {
            setTimeout(() => replyMsg.delete().catch(() => {}), 6000);
          })
          .catch(() => {});
      }
    }
  } catch (err) {
    console.error('Error in bridge listener:', err.message);
  }
});

// Periodic automated drops trigger (every 5 minutes)
function pollAutomatedDrops() {
  if (!BRIDGE_SECRET) return;
  fetch(DROPS_URL, {
    method: 'POST',
    headers: {
      'x-bridge-token': BRIDGE_SECRET,
    },
    signal: AbortSignal.timeout(5000),
  })
    .then(async (r) => {
      if (r.ok) {
        const d = await r.json().catch(() => ({}));
        if (d.spawnedCount > 0) {
          console.log(`🎁 [Automated Drops] Spawned ${d.spawnedCount} drop(s) across active servers.`);
        }
      }
    })
    .catch((err) => {
      // Non-blocking cron poll error
    });
}

// Check drops every 5 minutes
setInterval(pollAutomatedDrops, 5 * 60 * 1000);
// Initial trigger 15 seconds after startup
setTimeout(pollAutomatedDrops, 15 * 1000);

client.login(TOKEN);
