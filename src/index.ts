import { Telegraf, Markup } from "telegraf";
import http from "http";
import dotenv from "dotenv";
import { pool, initDb } from "./db";
import { RESTAURANT, ADMIN_IDS, MENU } from "./config";
import {
  getCart,
  addToCart,
  removeFromCart,
  clearCart,
  cartTotal,
  getDraft,
  setDraft,
  clearDraft,
} from "./cart";

dotenv.config();

// Keep Render happy by opening a port
http.createServer((_, res) => res.end("OK")).listen(process.env.PORT || 3000);

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is not set in environment variables.");
}

const bot = new Telegraf(BOT_TOKEN);

// Prevent one bad/expired update from crashing the whole bot
bot.catch((err, ctx) => {
  console.error(`Bot error for update type ${ctx.updateType}:`, err);
});

function menuKeyboard() {
  const buttons = MENU.map((item) =>
    Markup.button.callback(`${item.name} — ${item.price} birr`, `add_${item.id}`)
  );
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }
  rows.push([Markup.button.callback("🛒 View Cart", "view_cart")]);
  return Markup.inlineKeyboard(rows);
}

function cartKeyboard(userId: number) {
  const cart = getCart(userId);
  const rows = cart.map((item) => [
    Markup.button.callback(`${item.name} x${item.quantity}`, "noop"),
    Markup.button.callback("➖", `remove_${item.id}`),
    Markup.button.callback("➕", `add_${item.id}`),
  ]);
  rows.push([Markup.button.callback("✅ Checkout", "checkout")]);
  rows.push([Markup.button.callback("🍽 Back to Menu", "back_to_menu")]);
  return Markup.inlineKeyboard(rows);
}

// --- Commands ---

bot.start((ctx) => {
  console.log("Telegram user ID:", ctx.from.id); // debug — check Render logs
  clearCart(ctx.from.id);
  clearDraft(ctx.from.id);
  ctx.reply(
    `Welcome to ${RESTAURANT.name}! 🍽\n${RESTAURANT.location}\n\nChoose items to add to your order:`,
    menuKeyboard()
  );
});

bot.command("menu", (ctx) => {
  ctx.reply("Our menu:", menuKeyboard());
});

// --- Menu interactions ---

bot.action(/^add_(.+)$/, async (ctx) => {
  const itemId = ctx.match[1];
  const item = MENU.find((m) => m.id === itemId);
  if (!item) return ctx.answerCbQuery("Item not found.");
  addToCart(ctx.from.id, item);
  await ctx.answerCbQuery(`Added ${item.name}`);
});

bot.action(/^remove_(.+)$/, async (ctx) => {
  const itemId = ctx.match[1];
  removeFromCart(ctx.from.id, itemId);
  await ctx.answerCbQuery("Removed");
  await showCart(ctx);
});

bot.action("noop", async (ctx) => {
  await ctx.answerCbQuery();
});

bot.action("back_to_menu", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText("Our menu:", menuKeyboard());
});

bot.action("view_cart", async (ctx) => {
  await ctx.answerCbQuery();
  await showCart(ctx);
});

async function showCart(ctx: any) {
  const userId = ctx.from.id;
  const cart = getCart(userId);
  if (cart.length === 0) {
    return ctx.editMessageText("Your cart is empty.", menuKeyboard());
  }
  const lines = cart.map((i) => `${i.name} x${i.quantity} — ${i.price * i.quantity} birr`);
  const total = cartTotal(userId);
  const text = `🛒 Your Cart:\n\n${lines.join("\n")}\n\nTotal: ${total} birr`;
  try {
    await ctx.editMessageText(text, cartKeyboard(userId));
  } catch {
    await ctx.reply(text, cartKeyboard(userId));
  }
}

// --- Checkout flow ---

bot.action("checkout", async (ctx) => {
  const userId = ctx.from.id;
  const cart = getCart(userId);
  if (cart.length === 0) {
    return ctx.answerCbQuery("Your cart is empty.");
  }
  await ctx.answerCbQuery();
  setDraft(userId, {});
  await ctx.reply(
    "Is this for delivery or pickup?",
    Markup.inlineKeyboard([
      [Markup.button.callback("🚗 Delivery", "order_type_delivery")],
      [Markup.button.callback("🏪 Pickup", "order_type_pickup")],
    ])
  );
});

bot.action(/^order_type_(delivery|pickup)$/, async (ctx) => {
  const userId = ctx.from.id;
  const orderType = ctx.match[1] as "delivery" | "pickup";
  setDraft(userId, { ...getDraft(userId), orderType });
  await ctx.answerCbQuery();

  if (orderType === "delivery") {
    await ctx.reply("Please send your delivery address:");
  } else {
    await ctx.reply("Please send your full name for the order:");
  }
});

// Handle free-text replies depending on checkout step
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const draft = getDraft(userId);
  if (!draft.orderType) return;

  if (draft.orderType === "delivery" && !draft.deliveryAddress) {
    setDraft(userId, { ...draft, deliveryAddress: ctx.message.text });
    return ctx.reply("Please send your full name for the order:");
  }

  if (!draft.customerName) {
    setDraft(userId, { ...draft, customerName: ctx.message.text });
    return ctx.reply("Please send your phone number:");
  }

  if (!draft.customerPhone) {
    const updatedDraft = { ...draft, customerPhone: ctx.message.text };
    setDraft(userId, updatedDraft);
    await finalizeOrder(ctx, updatedDraft);
    return;
  }
});

async function finalizeOrder(ctx: any, draft: ReturnType<typeof getDraft>) {
  const userId = ctx.from.id;
  const cart = getCart(userId);
  const total = cartTotal(userId);

  const result = await pool.query(
    `INSERT INTO orders (customer_telegram_id, customer_name, customer_phone, order_type, delivery_address, total_amount, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending_payment') RETURNING id`,
    [userId, draft.customerName, draft.customerPhone, draft.orderType, draft.deliveryAddress ?? null, total]
  );
  const orderId = result.rows[0].id;

  for (const item of cart) {
    await pool.query(
      `INSERT INTO order_items (order_id, item_id, item_name, item_price, quantity) VALUES ($1, $2, $3, $4, $5)`,
      [orderId, item.id, item.name, item.price, item.quantity]
    );
  }

  setDraft(userId, { ...draft, awaitingScreenshotFor: orderId });

  const summary = cart
    .map((i) => `${i.name} x${i.quantity} — ${i.price * i.quantity} birr`)
    .join("\n");

  await ctx.reply(
    `Order #${orderId} received! ✅\n\n${summary}\n\nTotal: ${total} birr\n\n` +
      `Please transfer to:\n🏦 ${RESTAURANT.bank.name}\n` +
      `Account: ${RESTAURANT.bank.account}\n` +
      `Name: ${RESTAURANT.bank.accountName}\n\n` +
      `Then send a screenshot of the payment here to confirm your order.`
  );

  clearCart(userId);
}

// Handle payment screenshot
bot.on("photo", async (ctx) => {
  const userId = ctx.from.id;
  const draft = getDraft(userId);
  if (!draft.awaitingScreenshotFor) {
    return ctx.reply("I wasn't expecting a photo right now. Use /menu to start an order.");
  }

  const orderId = draft.awaitingScreenshotFor;
  const photos = ctx.message.photo;
  const fileId = photos[photos.length - 1].file_id;

  await pool.query(
    `UPDATE orders SET payment_screenshot_file_id = $1, status = 'payment_submitted' WHERE id = $2`,
    [fileId, orderId]
  );

  await ctx.reply(
    `Thanks! Your payment screenshot was received for Order #${orderId}. ` +
      `${RESTAURANT.name} will confirm your order shortly. 🙏`
  );

  // Notify admins
  const orderResult = await pool.query(`SELECT * FROM orders WHERE id = $1`, [orderId]);
  const order = orderResult.rows[0];
  const itemsResult = await pool.query(`SELECT * FROM order_items WHERE order_id = $1`, [orderId]);
  const items = itemsResult.rows;
  const itemLines = items
    .map((i: any) => `${i.item_name} x${i.quantity} — ${i.item_price * i.quantity} birr`)
    .join("\n");

  const orderTypeLine =
    order.order_type === "delivery"
      ? `🚗 Delivery to: ${order.delivery_address}`
      : `🏪 Pickup at ${RESTAURANT.location}`;

  const adminText =
    `🆕 New Order #${order.id} — Payment Submitted\n\n` +
    `👤 ${order.customer_name}\n📞 ${order.customer_phone}\n${orderTypeLine}\n\n` +
    `${itemLines}\n\nTotal: ${order.total_amount} birr`;

  for (const adminId of ADMIN_IDS) {
    try {
      await bot.telegram.sendPhoto(adminId, fileId, { caption: adminText });
    } catch (err) {
      console.error(`Failed to notify admin ${adminId}:`, err);
    }
  }

  clearDraft(userId);
});

// --- Admin commands ---

function isAdmin(userId: number) {
  return ADMIN_IDS.map(Number).includes(Number(userId));
}

bot.command("confirm", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const orderId = parseInt(ctx.message.text.split(" ")[1], 10);
  if (!orderId) return ctx.reply("Usage: /confirm <order_id>");
  await pool.query(`UPDATE orders SET status = 'confirmed' WHERE id = $1`, [orderId]);
  const orderResult = await pool.query(`SELECT * FROM orders WHERE id = $1`, [orderId]);
  const order = orderResult.rows[0];
  if (order) {
    await bot.telegram.sendMessage(
      order.customer_telegram_id,
      `Your order #${orderId} has been confirmed! ${RESTAURANT.name} is preparing it now. 🍽`
    );
  }
  ctx.reply(`Order #${orderId} marked as confirmed.`);
});

bot.command("orders", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const result = await pool.query(
    `SELECT id, customer_name, order_type, total_amount, status, created_at FROM orders ORDER BY created_at DESC LIMIT 10`
  );
  if (result.rows.length === 0) return ctx.reply("No orders yet.");
  const lines = result.rows.map(
    (o: any) =>
      `#${o.id} — ${o.customer_name} — ${o.order_type} — ${o.total_amount} birr — ${o.status}`
  );
  ctx.reply(lines.join("\n"));
});

// --- Startup ---

initDb()
  .then(() => bot.launch({ dropPendingUpdates: true }))
  .then(() => console.log(`${RESTAURANT.name} bot is running.`))
  .catch((err) => console.error("Startup error:", err));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
