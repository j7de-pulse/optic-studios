import { readFileSync } from 'node:fs';
import {
  ActionRowBuilder,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

const loadLayout = (name) =>
  JSON.parse(readFileSync(new URL(`../services/${name}.json`, import.meta.url), 'utf8'));

const servicesPanel = loadLayout('services');
const orderTicket = loadLayout('order-ticket');

const { DISCORD_TOKEN, ORDER_CATEGORY_ID, STAFF_ROLE_ID } = process.env;

// Select menu value -> channel name prefix
const ORDER_TYPES = {
  logos: { label: 'Logos', channel: 'logos' },
  banners: { label: 'Banners', channel: 'banners' },
  bundles: { label: 'Bundle (Both)', channel: 'bundles' },
};

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (c) => {
  await c.application.commands.set([
    {
      name: 'services',
      description: 'Post the Services order panel in this channel',
      default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
      dm_permission: false,
    },
  ]);
  console.log(`Logged in as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'services') {
      await interaction.channel.send(servicesPanel);
      await interaction.reply({ content: 'Services panel posted.', flags: MessageFlags.Ephemeral });
    } else if (interaction.isStringSelectMenu() && interaction.customId === 'openOrder') {
      await showOrderModal(interaction);
    } else if (interaction.isModalSubmit() && interaction.customId.startsWith('orderModal:')) {
      await openOrderChannel(interaction);
    } else if (interaction.isButton() && interaction.customId === 'ticketClaim') {
      await claimTicket(interaction);
    } else if (interaction.isButton() && interaction.customId === 'ticketClose') {
      await closeTicket(interaction);
    }
  } catch (err) {
    console.error(err);
    const reply = { content: 'Something went wrong, please try again.', flags: MessageFlags.Ephemeral };
    if (interaction.isRepliable()) {
      await (interaction.deferred || interaction.replied
        ? interaction.followUp(reply)
        : interaction.reply(reply)
      ).catch(() => {});
    }
  }
});

async function showOrderModal(interaction) {
  const type = ORDER_TYPES[interaction.values[0]];
  if (!type) return;

  const modal = new ModalBuilder()
    .setCustomId(`orderModal:${interaction.values[0]}`)
    .setTitle(`${type.label} Order`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('description')
          .setLabel('Describe what you want')
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(1500)
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('budget')
          .setLabel('Budget')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(100)
          .setRequired(true),
      ),
    );
  await interaction.showModal(modal);
}

async function openOrderChannel(interaction) {
  const key = interaction.customId.split(':')[1];
  const type = ORDER_TYPES[key];
  if (!type) return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { guild, user } = interaction;
  const topic = `order:${key}:${user.id}`;
  const existing = guild.channels.cache.find((ch) => ch.topic === topic);
  if (existing) {
    await interaction.editReply(`You already have an open ${type.label} order: ${existing}`);
    return;
  }

  const permissionOverwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
    {
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageChannels,
      ],
    },
  ];
  if (STAFF_ROLE_ID) {
    permissionOverwrites.push({
      id: STAFF_ROLE_ID,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    });
  }

  const channel = await guild.channels.create({
    name: `🔴・${type.channel}-${user.username}`,
    type: ChannelType.GuildText,
    parent: ORDER_CATEGORY_ID || null,
    topic,
    permissionOverwrites,
  });

  await channel.send(
    buildTicketMessage({
      customer: `${user}`,
      description: interaction.fields.getTextInputValue('description'),
      budget: interaction.fields.getTextInputValue('budget'),
    }),
  );

  await interaction.editReply(`Your order channel has been opened: ${channel}`);
}

function buildTicketMessage(values) {
  const message = structuredClone(orderTicket);
  const fill = (node) => {
    if (Array.isArray(node)) return node.forEach(fill);
    if (node && typeof node === 'object') {
      if (node.type === 10) {
        node.content = node.content.replace(/\{(\w+)\}/g, (m, k) => values[k] ?? m);
      }
      Object.values(node).forEach(fill);
    }
  };
  fill(message.components);
  return message;
}

const isStaff = (member) =>
  (STAFF_ROLE_ID && member.roles.cache.has(STAFF_ROLE_ID)) ||
  member.permissions.has(PermissionFlagsBits.ManageChannels);

async function claimTicket(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Only staff can claim orders.', flags: MessageFlags.Ephemeral });
    return;
  }
  // 🔴 -> 🟢 marks the order as claimed
  await interaction.channel.setName(interaction.channel.name.replace('🔴', '🟢'));
  await interaction.reply(`This order has been claimed by ${interaction.user}.`);
}

async function closeTicket(interaction) {
  const ownerId = interaction.channel.topic?.split(':')[2];
  if (!isStaff(interaction.member) && interaction.user.id !== ownerId) {
    await interaction.reply({ content: 'You cannot close this order.', flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.reply('Closing this order in 5 seconds...');
  setTimeout(() => interaction.channel.delete().catch(console.error), 5000);
}

client.login(DISCORD_TOKEN);
