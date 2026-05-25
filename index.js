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

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID environment variables.');
  process.exit(1);
}

const DB_PATH = './database.json';
const LEAGUE_CHANNEL_ID = '1501829215291703378';
const LEAGUES_PING_ROLE_ID = '1504161847102804069';
const LEAGUE_HOST_ROLE_ID = '1504161875644907714';

function readDB() {
  if (!fs.existsSync(DB_PATH)) {
    const init = { leagues: {}, nextId: 1 };
    fs.writeFileSync(DB_PATH, JSON.stringify(init, null, 2));
    return init;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function maxPlayers(format) {
  return { '2v2': 4, '3v3': 6, '4v4': 8 }[format];
}

const pendingSessions = {};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
  ],
});

client.once('ready', async () => {
  console.log(`Online: ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName('host-league')
      .setDescription('Host a new league (League Host role required)'),
    new SlashCommandBuilder()
      .setName('join-league')
      .setDescription('Join an active league')
      .addStringOption(o =>
        o.setName('id').setDescription('League ID').setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('cancel-league')
      .setDescription('Cancel an active league (League Host role required)')
      .addStringOption(o =>
        o.setName('id').setDescription('League ID').setRequired(true)
      ),
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log('Slash commands registered.');
});

function buildLeagueEmbed(league) {
  const spots = league.maxPlayers - league.players.length;
  const statusColor =
    league.status === 'cancelled' ? 0x7f8c8d :
    league.status === 'full' ? 0xe74c3c :
    0x1a1a2e;

  return new EmbedBuilder()
    .setTitle(
      league.status === 'cancelled' ? 'League Cancelled' :
      league.status === 'full' ? 'League Full' :
      'League Open'
    )
    .setColor(statusColor)
    .addFields(
      { name: 'Format',          value: league.format,                             inline: true },
      { name: 'Match Type',      value: league.type,                               inline: true },
      { name: 'Perks',           value: league.perks,                              inline: true },
      { name: 'Region',          value: league.region,                             inline: true },
      { name: 'Host',            value: `<@${league.hostId}>`,                     inline: true },
      { name: 'Players',         value: `${league.players.length} / ${league.maxPlayers}`, inline: true },
      { name: 'Spots Remaining', value: `${spots}`,                                inline: true },
      { name: 'League ID',       value: `\`${league.id}\``,                        inline: true },
    )
    .setFooter({ text: `To cancel: /cancel-league ${league.id}` })
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

async function handleJoinLeague(interaction, leagueId) {
  const db = readDB();
  const league = db.leagues[leagueId];

  if (!league) {
    return interaction.reply({ content: `No league found with ID \`${leagueId}\`.`, ephemeral: true });
  }
  if (league.status === 'cancelled') {
    return interaction.reply({ content: `League \`${leagueId}\` has been cancelled.`, ephemeral: true });
  }
  if (league.status === 'full') {
    return interaction.reply({ content: `League \`${leagueId}\` is full.`, ephemeral: true });
  }
  if (league.players.includes(interaction.user.id)) {
    return interaction.reply({ content: 'You are already registered in this league.', ephemeral: true });
  }

  league.players.push(interaction.user.id);

  try {
    const thread = await client.channels.fetch(league.threadId);
    if (thread) {
      await thread.members.add(interaction.user.id);
      await thread.send(`<@${interaction.user.id}> has joined the league.`);
    }
  } catch (e) {
    console.error('Thread member add error:', e);
  }

  try {
    const leagueChannel = await client.channels.fetch(LEAGUE_CHANNEL_ID);
    const msg = await leagueChannel.messages.fetch(league.messageId);

    if (league.players.length >= league.maxPlayers) {
      league.status = 'full';
    }

    const embed = buildLeagueEmbed(league);
    const components = league.status === 'full' ? [] : [buildJoinButton(leagueId)];
    await msg.edit({ embeds: [embed], components });

    if (league.status === 'full') {
      try {
        const thread = await client.channels.fetch(league.threadId);
        if (thread) {
          await thread.send('All spots are filled. The league is now starting. Good luck to all participants.');
        }
      } catch (e) {
        console.error('Thread full notification error:', e);
      }
    }
  } catch (e) {
    console.error('Embed update error:', e);
  }

  writeDB(db);

  await interaction.reply({
    content: `You have joined League \`${leagueId}\`. A private thread has been opened for league participants.`,
    ephemeral: true,
  });
}

async function handleCancelLeague(interaction, leagueId) {
  const db = readDB();
  const league = db.leagues[leagueId];

  if (!league) {
    return interaction.reply({ content: `No league found with ID \`${leagueId}\`.`, ephemeral: true });
  }
  if (league.status === 'cancelled') {
    return interaction.reply({ content: `League \`${leagueId}\` is already cancelled.`, ephemeral: true });
  }

  league.status = 'cancelled';
  writeDB(db);

  try {
    const leagueChannel = await client.channels.fetch(LEAGUE_CHANNEL_ID);
    const msg = await leagueChannel.messages.fetch(league.messageId);
    await msg.edit({ embeds: [buildLeagueEmbed(league)], components: [] });
  } catch (e) {
    console.error('Cancel embed update error:', e);
  }

  try {
    const thread = await client.channels.fetch(league.threadId);
    if (thread) {
      await thread.send(
        `League \`${leagueId}\` has been cancelled by <@${interaction.user.id}>. This thread will now be archived.`
      );
      await thread.setArchived(true);
    }
  } catch (e) {
    console.error('Thread archive error:', e);
  }

  await interaction.reply({
    content: `League \`${leagueId}\` has been cancelled successfully.`,
    ephemeral: true,
  });
}

async function createLeague(interaction, session) {
  const db = readDB();
  const leagueId = String(db.nextId++);
  const max = maxPlayers(session.format);

  const league = {
    id: leagueId,
    format: session.format,
    type: session.type,
    perks: session.perks,
    region: session.region,
    hostId: interaction.user.id,
    hostTag: interaction.user.username,
    maxPlayers: max,
    players: [interaction.user.id],
    messageId: null,
    threadId: null,
    status: 'open',
  };

  const leagueChannel = await client.channels.fetch(LEAGUE_CHANNEL_ID);

  const thread = await leagueChannel.threads.create({
    name: `League ${leagueId} - ${session.format} ${session.type}`,
    type: ChannelType.PrivateThread,
    invitable: false,
    reason: `League ${leagueId} opened by ${interaction.user.username}`,
  });

  await thread.members.add(interaction.user.id);
  await thread.send(
    `**League ${leagueId} - Private Channel**\n\n` +
    `Format: **${session.format}** | Type: **${session.type}** | Perks: **${session.perks}** | Region: **${session.region}**\n` +
    `Host: <@${interaction.user.id}>\n\n` +
    `This thread is private. Only players who join this league will be added here.`
  );

  league.threadId = thread.id;

  const embed = buildLeagueEmbed(league);

  const msg = await leagueChannel.send({
    content: `<@&${LEAGUES_PING_ROLE_ID}>`,
    embeds: [embed],
    components: [buildJoinButton(leagueId)],
  });

  league.messageId = msg.id;
  db.leagues[leagueId] = league;
  writeDB(db);

  delete pendingSessions[interaction.user.id];

  await interaction.followUp({
    content: `League \`${leagueId}\` has been created. View it in <#${LEAGUE_CHANNEL_ID}>.`,
    ephemeral: true,
  });
}

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      if (commandName === 'host-league') {
        if (!interaction.member.roles.cache.has(LEAGUE_HOST_ROLE_ID)) {
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

        await interaction.reply({
          content: '**Host a League**\n\n**Step 1 of 4 - Match Format**\nSelect the format for your league:',
          components: [row],
          ephemeral: true,
        });
      }

      else if (commandName === 'join-league') {
        const leagueId = interaction.options.getString('id');
        await handleJoinLeague(interaction, leagueId);
      }

      else if (commandName === 'cancel-league') {
        if (!interaction.member.roles.cache.has(LEAGUE_HOST_ROLE_ID)) {
          return interaction.reply({ content: 'You do not have permission to cancel leagues.', ephemeral: true });
        }
        const leagueId = interaction.options.getString('id');
        await handleCancelLeague(interaction, leagueId);
      }
    }

    else if (interaction.isStringSelectMenu()) {
      const session = pendingSessions[interaction.user.id];
      if (!session) {
        return interaction.update({
          content: 'Your session has expired. Please run `/host-league` again.',
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

        await interaction.update({
          content:
            `**Host a League**\n\nFormat: **${session.format}**\n\n` +
            `**Step 2 of 4 - Match Type**\nSelect the match type:`,
          components: [row],
        });
      }

      else if (interaction.customId === 'select_type') {
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

        await interaction.update({
          content:
            `**Host a League**\n\nFormat: **${session.format}** | Type: **${session.type}**\n\n` +
            `**Step 3 of 4 - Match Perks**\nSelect the perks setting:`,
          components: [row],
        });
      }

      else if (interaction.customId === 'select_perks') {
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

        await interaction.update({
          content:
            `**Host a League**\n\nFormat: **${session.format}** | Type: **${session.type}** | Perks: **${session.perks}**\n\n` +
            `**Step 4 of 4 - Region**\nSelect the region:`,
          components: [row],
        });
      }

      else if (interaction.customId === 'select_region') {
        session.region = interaction.values[0];

        await interaction.update({
          content:
            `**Host a League**\n\nFormat: **${session.format}** | Type: **${session.type}** | Perks: **${session.perks}** | Region: **${session.region}**\n\n` +
            `Creating your league...`,
          components: [],
        });

        await createLeague(interaction, session);
      }
    }

    else if (interaction.isButton()) {
      if (interaction.customId.startsWith('join_')) {
        const leagueId = interaction.customId.slice(5);
        await handleJoinLeague(interaction, leagueId);
      }
    }

  } catch (err) {
    console.error('Interaction error:', err);
    try {
      const reply = { content: 'An error occurred while processing your request.', ephemeral: true };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(reply);
      } else {
        await interaction.reply(reply);
      }
    } catch (_) {}
  }
});

client.login(TOKEN);
