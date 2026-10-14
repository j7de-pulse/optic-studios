# Optic Studios Bot

Posts the Services panel and opens a private order channel when someone picks an
order type from the select menu.

| Selection     | Channel name               |
| ------------- | -------------------------- |
| Logos         | `🔴・logos-<username>`     |
| Banners       | `🔴・banners-<username>`   |
| Bundle (Both) | `🔴・bundles-<username>`   |

Picking an option asks for a description and budget, then creates the channel,
ghost-pings `@everyone` in it, and posts the order message
(`services/order-ticket.json`) with those details filled in.

Only the staff role/user (`STAFF_ID`, default `1556967527093899264`) can:

- **Claim**: renames the channel to `🟢・<type>-<claimer>`
- **Close**: deletes the channel after 5 seconds
- `-rename <new name>`: renames the order channel, keeping its 🔴/🟢 status

Bot replies live in `RESPONSES` at the top of `src/index.js`.

## Setup

1. `npm install`
2. Set `DISCORD_TOKEN`, either in your host's environment variables or in a
   `.env` file (copy `.env.example`). The `.env` file is optional. The order
   category and staff IDs are already set in `src/index.js`. Anyone in the
   server can open an order.
3. In the Developer Portal, under **Bot**, turn on **Message Content Intent**
   (needed for `-rename`).
4. Give the bot the **Manage Channels**, **Manage Roles** and **Mention
   Everyone** permissions.
5. `npm start`, then run `/services` in the channel where the panel should go.
