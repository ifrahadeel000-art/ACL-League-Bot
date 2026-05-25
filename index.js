require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  REST,
  Routes,
} = require('discord.js');

const fs = require('fs');

const TOKEN     = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID environment variables.');
  process.exit(1);
}

const DB_PATH            = './database.json';
const LEAGUE_CHANNEL_ID  = '1501829215291703378';
const LEAGUES_PING_ROLE  = '1501829213928554565';
const LEAGUE_HOST_ROLE   = '1501829213966176269';

// ── Helpers ──────────────────────────────────────────────────────────────────

function readDB() {
  if (!fs.existsSync(DB_PATH)) {
    const init = { leagues: {} };
    fs.writeFileSync(DB_PATH, JSON.stringify(init, null, 2));
    return init;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function generateId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function maxPlayers(format) {
  return { '2v2': 4, '3v3': 6, '4v4': 8 }[format];
}

// Pending host sessions keyed by userId
const pendingSessions = {};

// ── Discord Client ────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
  ],
});

// ── Register Slash Commands ───────────────────────────────────────────────────

client.once('ready', async () => {
  console.log(`Online: ${client.user.tag}`);

  const league = new SlashCommandBuilder()
    .setName('league')
    .setDescription('League management')
    .addSubcommand(sub =>
      sub.setName('host').setDescription('Host a new league (League Host role required)')
    )
    .addSubcommand(sub =>
      sub
        .setName('join')
        .setDescription('Join an active league')
        .addStringOption(o => o.setName('id').setDescription('League ID').setRequired(true))
    )
    .addSubcommand(sub =>
      sub
        .setName('cancel')
        .setDescription('Cancel a league (League Host role required)')
        .addStringOption(o => o.setName('id').setDescription('League ID').setRequired(true))
    );

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [league.toJSON()] });
  console.log('Slash commands registered.');
});

// ── Embed Builder ─────────────────────────────────────────────────────────────

function buildLeagueEmbed(league) {
  const spots    = league.maxPlayers - league.players.length;
  const playerMentions = league.players.map(id => `<@${id}>`).join('\n') || 'None';

  const color =
    league.status === 'cancelled' ? 0x7f8c8d :
    league.status === 'full'      ? 0xe74c3c :
    0x5865F2;

  const title =
    league.status === 'cancelled' ? 'League Cancelled' :
    league.status === 'full'      ? 'League Full'      :
    'League Available';

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .addFields(
      { name: 'Format',     value: league.format,         inline: true },
      { name: 'Match Type', value: league.type,           inline: true },
      { name: 'Perks',      value: league.perks,          inline: true },
      { name: 'Region',     value: league.region,         inline: true },
      { name: 'Host',       value: `<@${league.hostId}>`, inline: true },
      { name: 'Spots Left', value: `${league.players.length} / ${league.maxPlayers}`, inline: true },
      { name: 'Players',    value: playerMentions,        inline: false },
      { name: 'League ID',  value: `${league.id}`,        inline: false },
    )
    .setFooter({ text: `Cancel: /league cancel id:${league.id}` })
    .setTimestamp();

  return embed;
}

function buildJoinButton(leagueId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`join_${leagueId}`)
      .setLabel('Join League')
      .setStyle(ButtonStyle.Primary)
  );
}

// ── Join League ───────────────────────────────────────────────────────────────

async function handleJoin(interaction, leagueId) {
  const db     = readDB();
  const league = db.leagues[leagueId];

  if (!league)                               return interaction.reply({ content: `No league found with ID **${leagueId}**.`,       ephemeral: true });
  if (league.status === 'cancelled')         return interaction.reply({ content: `League **${leagueId}** has been cancelled.`,     ephemeral: true });
  if (league.status === 'full')              return interaction.reply({ content: `League **${leagueId}** is full.`,                ephemeral: true });
  if (league.players.includes(interaction.user.id)) return interaction.reply({ content: 'You are already in this league.', ephemeral: true });

  league.players.push(interaction.user.id);

  // Add to private thread
  try {
    const thread = await client.channels.fetch(league.threadId);
    if (thread) {
      await thread.members.add(interaction.user.id);
      await thread.send(`<@${interaction.user.id}> has joined the league.`);
    }
  } catch (e) {
    console.error('Thread add error:', e);
  }

  // Check if full
  if (league.players.length >= league.maxPlayers) {
    league.status = 'full';
  }

  // Update embed
  try {
    const ch  = await client.channels.fetch(LEAGUE_CHANNEL_ID);
    const msg = await ch.messages.fetch(league.messageId);
    const components = league.status === 'full' ? [] : [buildJoinButton(leagueId)];
    await msg.edit({ embeds: [buildLeagueEmbed(league)], components });

    if (league.status === 'full') {
      const thread = await client.channels.fetch(league.threadId).catch(() => null);
      if (thread) await thread.send('All spots are filled. The league is now starting. Good luck to all participants.');
    }
  } catch (e) {
    console.error('Embed update error:', e);
  }

  writeDB(db);

  await interaction.reply({
    content: `You have joined league **${leagueId}**. Check the private thread for details.`,
    ephemeral: true,
  });
}

// ── Cancel League ─────────────────────────────────────────────────────────────

async function handleCancel(interaction, leagueId) {
  const db     = readDB();
  const league = db.leagues[leagueId];

  if (!league)                       return interaction.reply({ content: `No league found with ID **${leagueId}**.`,          ephemeral: true });
  if (league.status === 'cancelled') return interaction.reply({ content: `League **${leagueId}** is already cancelled.`,     ephemeral: true });

  league.status = 'cancelled';
  writeDB(db);

  try {
    const ch  = await client.channels.fetch(LEAGUE_CHANNEL_ID);
    const msg = await ch.messages.fetch(league.messageId);
    await msg.edit({ embeds: [buildLeagueEmbed(league)], components: [] });
  } catch (e) {
    console.error('Embed cancel error:', e);
  }

  try {
    const thread = await client.channels.fetch(league.threadId).catch(() => null);
    if (thread) {
      await thread.send(`League **${leagueId}** has been cancelled by <@${interaction.user.id}>. This thread will now be archived.`);
      await thread.setArchived(true);
    }
  } catch (e) {
    console.error('Thread archive error:', e);
  }

  await interaction.reply({ content: `League **${leagueId}** has been cancelled.`, ephemeral: true });
}

// ── Create League ─────────────────────────────────────────────────────────────

async function createLeague(interaction, session) {
  const db = readDB();

  // Generate unique ID
  let leagueId;
  do { leagueId = generateId(); } while (db.leagues[leagueId]);

  const max = maxPlayers(session.format);

  const league = {
    id:         leagueId,
    format:     session.format,
    type:       session.type,
    perks:      session.perks,
    region:     session.region,
    hostId:     interaction.user.id,
    hostName:   interaction.user.username,
    maxPlayers: max,
    players:    [interaction.user.id],
    messageId:  null,
    pingMsgId:  null,
    threadId:   null,
    status:     'open',
  };

  const ch = await client.channels.fetch(LEAGUE_CHANNEL_ID);

  // Create private thread
  const thread = await ch.threads.create({
    name:      `League ${leagueId}`,
    type:      ChannelType.PrivateThread,
    invitable: false,
    reason:    `League ${leagueId} by ${interaction.user.username}`,
  });

  await thread.members.add(interaction.user.id);
  await thread.send(
    `**League ${leagueId} - Private Channel**\n\n` +
    `Format: **${session.format}** | Type: **${session.type}** | Perks: **${session.perks}** | Region: **${session.region}**\n` +
    `Host: <@${interaction.user.id}>\n\n` +
    `This thread is private. Only players who join this league will be added here.`
  );

  league.threadId = thread.id;

  // Post league embed
  const msg = await ch.send({
    embeds:     [buildLeagueEmbed(league)],
    components: [buildJoinButton(leagueId)],
  });

  league.messageId = msg.id;

  // Post separate ping message
  const pingMsg = await ch.send(`<@&${LEAGUES_PING_ROLE}> New league available: **${leagueId}**`);
  league.pingMsgId = pingMsg.id;

  db.leagues[leagueId] = league;
  writeDB(db);

  delete pendingSessions[interaction.user.id];

  await interaction.followUp({
    content: `League **${leagueId}** has been created in <#${LEAGUE_CHANNEL_ID}>.`,
    ephemeral: true,
  });
}

// ── Interaction Handler ───────────────────────────────────────────────────────

client.on('interactionCreate', async interaction => {
  try {

    // ── Slash Commands ────────────────────────────────────────────────────────
    if (interaction.isChatInputCommand() && interaction.commandName === 'league') {
      const sub = interaction.options.getSubcommand();

      // /league host
      if (sub === 'host') {
        if (!interaction.member.roles.cache.has(LEAGUE_HOST_ROLE)) {
          return interaction.reply({ content: 'You do not have permission to host leagues.', ephemeral: true });
        }
        if (interaction.channelId !== LEAGUE_CHANNEL_ID) {
          return interaction.reply({
            content: `Leagues can only be hosted in <#${LEAGUE_CHANNEL_ID}>.`,
            ephemeral: true,
          });
        }

        pendingSessions[interaction.user.id] = {};

        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('select_format')
            .setPlaceholder('Select a match format')
            .addOptions([
              { label: '2v2', value: '2v2', description: '2 players per team - 4 total' },
              { label: '3v3', value: '3v3', description: '3 players per team - 6 total' },
              { label: '4v4', value: '4v4', description: '4 players per team - 8 total' },
            ])
        );

        return interaction.reply({
          content: '**Host a League**\n\n**Step 1 of 4 - Match Format**\nSelect the format for your league:',
          components: [row],
          ephemeral: true,
        });
      }

      // /league join <id>
      if (sub === 'join') {
        return handleJoin(interaction, interaction.options.getString('id').toUpperCase());
      }

      // /league cancel <id>
      if (sub === 'cancel') {
        if (!interaction.member.roles.cache.has(LEAGUE_HOST_ROLE)) {
          return interaction.reply({ content: 'You do not have permission to cancel leagues.', ephemeral: true });
        }
        return handleCancel(interaction, interaction.options.getString('id').toUpperCase());
      }
    }

    // ── Select Menus (host flow) ──────────────────────────────────────────────
    else if (interaction.isStringSelectMenu()) {
      const session = pendingSessions[interaction.user.id];
      if (!session) {
        return interaction.update({
          content: 'Your session has expired. Please run `/league host` again.',
          components: [],
        });
      }

      if (interaction.customId === 'select_format') {
        session.format = interaction.values[0];

        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('select_type')
            .setPlaceholder('Select a match type')
            .addOptions([
              { label: 'Swift Game', value: 'Swift Game' },
              { label: 'War Game',   value: 'War Game'   },
            ])
        );

        return interaction.update({
          content:
            `**Host a League**\n\nFormat: **${session.format}**\n\n` +
            `**Step 2 of 4 - Match Type**\nSelect the match type:`,
          components: [row],
        });
      }

      if (interaction.customId === 'select_type') {
        session.type = interaction.values[0];

        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('select_perks')
            .setPlaceholder('Select perks setting')
            .addOptions([
              { label: 'Perks',    value: 'Perks'    },
              { label: 'No Perks', value: 'No Perks' },
            ])
        );

        return interaction.update({
          content:
            `**Host a League**\n\nFormat: **${session.format}** | Type: **${session.type}**\n\n` +
            `**Step 3 of 4 - Match Perks**\nSelect the perks setting:`,
          components: [row],
        });
      }

      if (interaction.customId === 'select_perks') {
        session.perks = interaction.values[0];

        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('select_region')
            .setPlaceholder('Select a region')
            .addOptions([
              { label: 'Europe',        value: 'Europe'        },
              { label: 'Asia',          value: 'Asia'          },
              { label: 'North America', value: 'North America' },
              { label: 'South America', value: 'South America' },
              { label: 'Ocean',         value: 'Ocean'         },
            ])
        );

        return interaction.update({
          content:
            `**Host a League**\n\nFormat: **${session.format}** | Type: **${session.type}** | Perks: **${session.perks}**\n\n` +
            `**Step 4 of 4 - Region**\nSelect the region:`,
          components: [row],
        });
      }

      if (interaction.customId === 'select_region') {
        session.region = interaction.values[0];

        await interaction.update({
          content:
            `**Host a League**\n\nFormat: **${session.format}** | Type: **${session.type}** | Perks: **${session.perks}** | Region: **${session.region}**\n\n` +
            `Creating your league...`,
          components: [],
        });

        return createLeague(interaction, session);
      }
    }

    // ── Buttons ───────────────────────────────────────────────────────────────
    else if (interaction.isButton()) {
      if (interaction.customId.startsWith('join_')) {
        return handleJoin(interaction, interaction.customId.slice(5));
      }
    }

  } catch (err) {
    console.error('Interaction error:', err);
    try {
      const msg = { content: 'An error occurred. Please try again.', ephemeral: true };
      if (interaction.deferred || interaction.replied) await interaction.followUp(msg);
      else await interaction.reply(msg);
    } catch (_) {}
  }
});

client.login(TOKEN);
