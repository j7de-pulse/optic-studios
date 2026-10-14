# Optic Studios Bot

Posts the Services panel and opens a private order channel when someone picks an
order type from the select menu.

| Selection     | Channel name               |
| ------------- | -------------------------- |
| Logos         | `🔴・logos-<username>`     |
| Banners       | `🔴・banners-<username>`   |
| Bundle (Both) | `🔴・bundles-<username>`   |

Picking an option asks for a description and budget, then creates the channel and
posts the order message (`services/order-ticket.json`) with those details filled in.
**Claim** (staff only) switches the channel's 🔴 to 🟢; **Close** (staff or the
customer) deletes the channel.

## Setup

1. `npm install`
2. Set `DISCORD_TOKEN`, either in your host's environment variables or in a
   `.env` file (copy `.env.example`). The `.env` file is optional. The order
   category and staff role IDs are already set in `src/index.js`. Anyone in the
   server can open an order.
3. Give the bot the **Manage Channels** and **Manage Roles** permissions.
4. `npm start`, then run `/services` in the channel where the panel should go.
