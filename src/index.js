import { readFileSync } from 'node:fs';
import Stripe from 'stripe';
import {
  ActionRowBuilder,
  ChannelType,
  Client,
  ComponentType,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  OverwriteType,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

// Read .env when present; hosts that set environment variables in a dashboard won't have one
try {
  process.loadEnvFile();
} catch {}

const loadLayout = (name) =>
  JSON.parse(readFileSync(new URL(`../services/${name}.json`, import.meta.url), 'utf8'));

const servicesPanel = loadLayout('services');
const orderTicket = loadLayout('order-ticket');
const paymentLayout = loadLayout('payment');

// Server IDs aren't secret, so they live here; environment variables override them
const {
  DISCORD_TOKEN,
  // Secret key from the Stripe dashboard; -usd is disabled without it
  STRIPE_SECRET_KEY,
  ORDER_CATEGORY_ID = '1556970533789245510',
  // Role (or single user) that can see, claim, close and rename every order
  STAFF_ID = '1556967527093899264',
  // User (or role) allowed to send bills with -usd, as well as STAFF_ID
  BILLING_ID = '737181735846019112',
} = process.env;

if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is not set. Add it to your host\'s environment variables or a .env file.');
  process.exit(1);
}

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// Select menu value -> channel name prefix
const ORDER_TYPES = {
  logos: { label: 'Logos', channel: 'logos' },
  banners: { label: 'Banners', channel: 'banners' },
  bundles: { label: 'Bundle (Both)', channel: 'bundles' },
};

const RESPONSES = {
  opened: (channel) => `Your ticket has been opened: ${channel}`,
  alreadyOpen: (channel) => `You already have an open ticket: ${channel}`,
  claimed: (user) => `Your ticket has now been claimed by ${user}.`,
  alreadyClaimed: (user) => `This ticket has already been claimed by ${user}.`,
  closing: 'This ticket will be closed in 5 seconds.',
  renamed: (name) => `This ticket has been renamed to **${name}**.`,
  renameUsage: 'Usage: `-rename <new name>`',
  usdUsage: 'Usage: `-usd <@user> <price>`, for example `-usd @bob 22` or `-usd @bob 22.50`. The minimum is $0.50.',
  paymentsDisabled: 'Payments are not set up yet. Add `STRIPE_SECRET_KEY` to the bot\'s environment variables.',
  noPermission: 'You do not have permission to do this.',
  botMissingPermissions:
    'I could not create your ticket because I am missing permissions. ' +
    'Please ask staff to give my role **Manage Channels** and **Manage Roles**.',
};

// MessageContent is needed for -rename; enable "Message Content Intent" in the Developer Portal
const MEMBER_ACCESS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.ReadMessageHistory,
];

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

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
    const reply = { content: `Something went wrong: ${err.message}`, flags: MessageFlags.Ephemeral };
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
  const existing = guild.channels.cache.find((ch) => {
    const order = ch.topic && parseTopic(ch);
    return order?.type === key && order.customerId === user.id;
  });
  if (existing) {
    await interaction.editReply(RESPONSES.alreadyOpen(existing));
    return;
  }

  const permissionOverwrites = [
    { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    { id: user.id, type: OverwriteType.Member, allow: MEMBER_ACCESS },
    {
      id: client.user.id,
      type: OverwriteType.Member,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
    },
  ];
  const staffOverwrite = await resolveStaffOverwrite(guild);
  if (staffOverwrite) permissionOverwrites.push(staffOverwrite);

  const options = {
    name: `🔴・${type.channel}-${user.username}`,
    type: ChannelType.GuildText,
    topic,
    permissionOverwrites,
  };
  const category = ORDER_CATEGORY_ID && guild.channels.cache.get(ORDER_CATEGORY_ID);
  if (category?.type === ChannelType.GuildCategory) {
    options.parent = category.id;
  } else if (ORDER_CATEGORY_ID) {
    console.warn(`ORDER_CATEGORY_ID ${ORDER_CATEGORY_ID} is not a category in ${guild.name}; creating the channel without one`);
  }

  let channel;
  try {
    channel = await guild.channels.create(options);
  } catch (err) {
    if (err.code === 50013) {
      console.error(err);
      await interaction.editReply(RESPONSES.botMissingPermissions);
      return;
    }
    throw err;
  }

  // Ghost ping: notify everyone who can see the ticket, then remove the ping
  const ping = await channel.send({ content: '@everyone', allowedMentions: { parse: ['everyone'] } });
  await ping.delete().catch(() => {});

  await channel.send(
    fillLayout(orderTicket, {
      customer: `${user}`,
      description: interaction.fields.getTextInputValue('description'),
      budget: interaction.fields.getTextInputValue('budget'),
    }),
  );

  await interaction.editReply(RESPONSES.opened(channel));
}

// Copy a layout and replace {placeholders} in its text and URLs
function fillLayout(layout, values) {
  const message = structuredClone(layout);
  const fill = (node) => {
    if (Array.isArray(node)) return node.forEach(fill);
    if (node && typeof node === 'object') {
      for (const key of ['content', 'url']) {
        if (typeof node[key] === 'string') {
          node[key] = node[key].replace(/\{(\w+)\}/g, (m, k) => values[k] ?? m);
        }
      }
      Object.values(node).forEach(fill);
    }
  };
  fill(message.components);
  return message;
}

// Order channel topic: order:<type>:<customerId>[:<claimerId>]
const parseTopic = (channel) => {
  const [tag, type, customerId, claimerId] = channel.topic?.split(':') ?? [];
  return tag === 'order' ? { type, customerId, claimerId } : null;
};

const hasId = (member, id) => member.id === id || member.roles.cache.has(id);
const isStaff = (member) => hasId(member, STAFF_ID);
const canBill = (member) => hasId(member, BILLING_ID) || isStaff(member);

// STAFF_ID may be a role or a single user; skip it if it's neither in this server
async function resolveStaffOverwrite(guild) {
  if (guild.roles.cache.has(STAFF_ID)) {
    return { id: STAFF_ID, type: OverwriteType.Role, allow: MEMBER_ACCESS };
  }
  const member = await guild.members.fetch(STAFF_ID).catch(() => null);
  if (member) return { id: STAFF_ID, type: OverwriteType.Member, allow: MEMBER_ACCESS };
  console.warn(`STAFF_ID ${STAFF_ID} is not a role or member in ${guild.name}`);
  return null;
}

// Wrap text in a Components V2 container (V2 messages can't use plain `content`)
const v2Container = (text) => ({
  flags: MessageFlags.IsComponentsV2,
  components: [{ type: ComponentType.Container, components: [{ type: ComponentType.TextDisplay, content: text }] }],
});

async function claimTicket(interaction) {
  const { channel, member, user } = interaction;
  const order = parseTopic(channel);
  if (!order) return;
  if (!isStaff(member)) {
    await interaction.reply({ content: RESPONSES.noPermission, flags: MessageFlags.Ephemeral });
    return;
  }
  if (order.claimerId) {
    await interaction.reply({
      content: RESPONSES.alreadyClaimed(`<@${order.claimerId}>`),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.reply(v2Container(RESPONSES.claimed(user)));
  // One edit for name and topic: Discord only allows 2 renames per channel every 10 minutes
  await channel.edit({
    name: `🟢・${order.type}-${user.username}`,
    topic: `order:${order.type}:${order.customerId}:${user.id}`,
  });
}

async function closeTicket(interaction) {
  if (!parseTopic(interaction.channel)) return;
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: RESPONSES.noPermission, flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.reply(RESPONSES.closing);
  setTimeout(() => interaction.channel.delete().catch(console.error), 5000);
}

const MESSAGE_COMMANDS = {
  '-rename': { run: renameTicket, allowed: isStaff, ticketOnly: true },
  '-usd': { run: sendBill, allowed: canBill, ticketOnly: false },
};

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.inGuild()) return;
  const [name, ...args] = message.content.trim().split(/\s+/);
  const command = MESSAGE_COMMANDS[name.toLowerCase()];
  const order = parseTopic(message.channel);
  if (!command || (command.ticketOnly && !order)) return;
  try {
    if (!command.allowed(message.member)) {
      await message.reply(RESPONSES.noPermission);
      return;
    }
    await command.run(message, args.join(' '), order);
  } catch (err) {
    console.error(err);
    await message.reply(`Something went wrong: ${err.message}`).catch(() => {});
  }
});

async function renameTicket(message, input) {
  // Discord lowercases text channel names and turns spaces into dashes
  const newName = input.toLowerCase().replace(/\s+/g, '-');
  if (!newName) {
    await message.reply(RESPONSES.renameUsage);
    return;
  }
  // Keep the 🔴/🟢 status in front of the new name
  const status = message.channel.name.match(/^(🔴|🟢)・/)?.[0] ?? '';
  const name = `${status}${newName}`.slice(0, 100);
  await message.reply(RESPONSES.renamed(name));
  await message.channel.setName(name);
}

async function sendBill(message, input, order) {
  if (!stripe) {
    await message.reply(RESPONSES.paymentsDisabled);
    return;
  }
  // -usd <@user | user id> <price>
  const [target = '', price = ''] = input.split(/\s+/);
  const userId = target.match(/^(?:<@!?)?(\d{17,20})>?$/)?.[1];
  const dollars = Number(price.replace(/^\$/, '').replace(/,/g, ''));
  const cents = Math.round(dollars * 100);
  // Stripe's minimum card charge is $0.50
  if (!userId || !price || !Number.isFinite(dollars) || cents < 50 || cents > 99999999) {
    await message.reply(RESPONSES.usdUsage);
    return;
  }

  const ticketUrl = message.channel.url;
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: cents,
          product_data: { name: `Optic Studios ${ORDER_TYPES[order?.type]?.label ?? ''} order`.replace(/\s+/g, ' ') },
        },
      },
    ],
    success_url: ticketUrl,
    cancel_url: ticketUrl,
    // Checkout links last at most 24 hours
    expires_at: Math.floor(Date.now() / 1000) + 23 * 60 * 60,
    metadata: { channel_id: message.channel.id, customer_id: userId },
  });

  const amount = (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  await message.channel.send({
    ...fillLayout(paymentLayout, { customer: `<@${userId}>`, amount, url: session.url }),
    allowedMentions: { users: [userId] },
  });
}

client.login(DISCORD_TOKEN);
