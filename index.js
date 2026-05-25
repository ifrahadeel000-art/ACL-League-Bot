require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
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

const DB_PATH           = './database.json';
const LEAGUE_CHANNEL_ID = '1501829215291703378';
const LEAGUES_PING_ROLE = '1501829213928554565';
const LEAGUE_HOST_ROLE  = '1501829213966176269';

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Discord Client ────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
  ],
});

// ── Register Commands ─────────────────────────────────────────────────────────

client.once('ready', async () => {
  console.log(`Online: ${client.user.tag}`);

  const league = new SlashCommandBuilder()
    .setName('league')
    .setDescription('League management')
    .addSubcommand(sub =>
      sub
        .setName('host')
        .setDescription('Host a league')
        .addStringOption(o =>
          o
            .setName('format')
            .setDescription('Match format')
            .setRequired(true)
            .addChoices(
              { name: '2v2', value: '2v2' },
              { name: '3v3', value: '3v3' },
              { name: '4v4', value: '4v4' },
            )
        )
        .addStringOption(o =>
          o
            .setName('match_type')
            .setDescription('Match type')
            .setRequired(true)
            .addChoices(
              { name: 'Swift Game', value: 'Swift Game' },
              { name: 'War Game',   value: 'War Game'   },
            )
        )
        .addStringOption(o =>
          o
            .setName('perks')
            .setDescription('Match perks')
            .setRequired(true)
            .addChoices(
              { name: 'Perks',    value: 'Perks'    },
              { name: 'No Perks', value: 'No Perks' },
            )
        )
        .addStringOption(o =>
          o
            .setName('region')
            .setDescription('Region')
            .setRequired(true)
            .addChoices(
              { name: 'Europe',        value: 'Europe'        },
              { name: 'Asia',          value: 'Asia'          },
              { name: 'North America', value: 'North America' },
              { name: 'South America', value: 'South America' },
              { name: 'Ocean',         value: 'Ocean'         },
            )
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('join')
        .setDescription('Join an active league')
        .addStringOption(o =>
          o.setName('id').setDescription('League ID').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('cancel')
        .setDescription('Cancel a league (League Host role required)')
        .addStringOption(o =>
          o.setName('id').setDescription('League ID').setRequired(true)
        )
    );

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [league.toJSON()] });
  console.log('Slash commands registered.');
});

// ── Embed Builder ─────────────────────────────────────────────────────────────

function buildLeagueEmbed(league) {
  const spots         = league.maxPlayers - league.players.length;
  const playerList    = league.players.map(id => `<@${id}>`).join('\n') || 'None';

  const color =
    league.status === 'cancelled' ? 0x7f8c8d :
    league.status === 'full'      ? 0xe74c3c :
    0x5865F2;

  const title =
    league.status === 'cancelled' ? 'League Cancelled' :
    league.status === 'full'      ? 'League Full'      :
    'League Available';

  return new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .addFields(
      { name: 'Format',     value: league.format,                                      inline: true },
      { name: 'Match Type', value: league.type,                                        inline: true },
      { name: 'Perks',      value: league.perks,                                       inline: true },
      { name: 'Region',     value: league.region,                                      inline: true },
      { name: 'Host',       value: `<@${league.hostId}>`,                              inline: true },
      { name: 'Spots Left', value: `${league.players.length} / ${league.maxPlayers}`,  inline: true },
      { name: 'Players',    value: playerList,                                         inline: false },
      { name: 'League ID',  value: `${league.id}`,                                    inline: false },
    )
    .setFooter({ text: `Cancel: /league cancel id:${league.id}` })
    .setTimestamp();
}

function buildJoinButton(leagueId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`join_${leagueId}`)
      .setLabel('Join League')
      .setStyle(ButtonStyle.Primary)
  );
}

// ── Create League ─────────────────────────────────────────────────────────────

async function createLeague(interaction) {
  const format    = interaction.options.getString('format');
  const matchType = interaction.options.getString('match_type');
  const perks     = interaction.options.getString('perks');
  const region    = interaction.options.getString('region');

  await interaction.deferReply({ ephemeral: true });

  const db = readDB();

  let leagueId;
  do { leagueId = generateId(); } while (db.leagues[leagueId]);

  const league = {
    id:         leagueId,
    format,
    type:       matchType,
    perks,
    region,
    hostId:     interaction.user.id,
    hostName:   interaction.user.username,
    maxPlayers: maxPlayers(format),
    players:    [interaction.user.id],
    messageId:  null,
    pingMsgId:  null,
    threadId:   null,
    status:     'open',
  };

  const ch = await client.channels.fetch(LEAGUE_CHANNEL_ID);

  // Private thread
  const thread = await ch.threads.create({
    name:      `League ${leagueId}`,
    type:      ChannelType.PrivateThread,
    invitable: false,
    reason:    `League ${leagueId} by ${interaction.user.username}`,
  });

  await thread.members.add(interaction.user.id);
  await thread.send(
    `**League ${leagueId} - Private Channel**\n\n` +
    `Format: **${format}** | Type: **${matchType}** | Perks: **${perks}** | Region: **${region}**\n` +
    `Host: <@${interaction.user.id}>\n\n` +
    `This thread is private. Only players who join this league will be added here.`
  );

  league.threadId = thread.id;

  // League embed
  const msg = await ch.send({
    embeds:     [buildLeagueEmbed(league)],
    components: [buildJoinButton(leagueId)],
  });

  league.messageId = msg.id;

  // Separate ping message
  const pingMsg = await ch.send(`<@&${LEAGUES_PING_ROLE}> New league available: **${leagueId}**`);
  league.pingMsgId = pingMsg.id;

  db.leagues[leagueId] = league;
  writeDB(db);

  await interaction.editReply({ content: `League **${leagueId}** has been created in <#${LEAGUE_CHANNEL_ID}>.` });
}

// ── Join League ───────────────────────────────────────────────────────────────

async function handleJoin(interaction, leagueId) {
  const db     = readDB();
  const league = db.leagues[leagueId];

  if (!league)                                        return interaction.reply({ content: `No league found with ID **${leagueId}**.`,    ephemeral: true });
  if (league.status === 'cancelled')                  return interaction.reply({ content: `League **${leagueId}** has been cancelled.`,  ephemeral: true });
  if (league.status === 'full')                       return interaction.reply({ content: `League **${leagueId}** is full.`,             ephemeral: true });
  if (league.players.includes(interaction.user.id))  return interaction.reply({ content: 'You are already in this league.',            ephemeral: true });

  league.players.push(interaction.user.id);

  try {
    const thread = await client.channels.fetch(league.threadId);
    if (thread) {
      await thread.members.add(interaction.user.id);
      await thread.send(`<@${interaction.user.id}> has joined the league.`);
    }
  } catch (e) {
    console.error('Thread add error:', e);
  }

  if (league.players.length >= league.maxPlayers) league.status = 'full';

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
    content:   `You have joined league **${leagueId}**. Check the private thread for details.`,
    ephemeral: true,
  });
}

// ── Cancel League ─────────────────────────────────────────────────────────────

async function handleCancel(interaction, leagueId) {
  const db     = readDB();
  const league = db.leagues[leagueId];

  if (!league)                       return interaction.reply({ content: `No league found with ID **${leagueId}**.`,      ephemeral: true });
  if (league.status === 'cancelled') return interaction.reply({ content: `League **${leagueId}** is already cancelled.`, ephemeral: true });

  league.status = 'cancelled';
  writeDB(db);

  try {
    const ch  = await client.channels.fetch(LEAGUE_CHANNEL_ID);
    const msg = await ch.messages.fetch(league.messageId);
    await msg.edit({ embeds: [buildLeagueEmbed(league)], components: [] });
  } catch (e) {
    console.error('Cancel embed error:', e);
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

// ── Interaction Handler ───────────────────────────────────────────────────────

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'league') {
      const sub = interaction.options.getSubcommand();

      if (sub === 'host') {
        if (!interaction.member.roles.cache.has(LEAGUE_HOST_ROLE)) {
          return interaction.reply({ content: 'You do not have permission to host leagues.', ephemeral: true });
        }
        if (interaction.channelId !== LEAGUE_CHANNEL_ID) {
          return interaction.reply({ content: `Leagues can only be hosted in <#${LEAGUE_CHANNEL_ID}>.`, ephemeral: true });
        }
        return createLeague(interaction);
      }

      if (sub === 'join') {
        return handleJoin(interaction, interaction.options.getString('id').toUpperCase());
      }

      if (sub === 'cancel') {
        if (!interaction.member.roles.cache.has(LEAGUE_HOST_ROLE)) {
          return interaction.reply({ content: 'You do not have permission to cancel leagues.', ephemeral: true });
        }
        return handleCancel(interaction, interaction.options.getString('id').toUpperCase());
      }
    }

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
