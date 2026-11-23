const { Client, GatewayIntentBits } = require('discord.js');
const http = require('http');

const PORT = process.env.PORT || 7860;
const VERCEL_URL = process.env.VERCEL_PREFIX_URL || 'https://dc-lwe.vercel.app/api/discord/prefix';
const TOKEN = process.env.DISCORD_TOKEN;

if (!TOKEN) {
  console.error('❌ Missing DISCORD_TOKEN environment variable! Please configure it in your host environment variables.');
}

// Lightweight HTTP server for Cloud Health Checks & Uptime pings
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'online',
    bot: client.user ? client.user.tag : 'connecting',
    uptime: process.uptime(),
  }));
}).listen(PORT, () => {
  console.log(`📡 Cloud health-check server listening on port ${PORT}`);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.on('ready', () => {
  console.log(`✅ Lwe Gateway Bridge online as ${client.user.tag}! Forwarding chat commands to ${VERCEL_URL}`);
  client.user.setActivity('lwe help | https://dc-lwe.vercel.app');
});

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot || !message.guild) return;

    const content = message.content.trim();
    if (!content.toLowerCase().startsWith('lwe')) {
      return;
    }

    // Forward to Vercel Serverless Endpoint
    fetch(VERCEL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        guildId: message.guild.id,
        channelId: message.channel.id,
        userId: message.author.id,
        userTag: message.author.username,
        memberPermissions: message.member?.permissions ? message.member.permissions.bitfield.toString() : '0',
        content: content,
      }),
    }).catch((err) => console.error('Failed to forward to Vercel:', err.message));
  } catch (err) {
    console.error('Error in bridge listener:', err.message);
  }
});

client.login(TOKEN);
