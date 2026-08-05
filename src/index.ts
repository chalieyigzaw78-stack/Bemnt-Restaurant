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

http.createServer((_, res) => res.end("OK")).listen(process.env.PORT || 3000);

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is not set in environment variables.");
}

const bot = new Telegraf(BOT_TOKEN);

// Tracks which item an admin is currently editing the price of
const adminPriceEdit = new Map<number, string>();

bot.catch((err, ctx) => {
  console.error(`Bot error for update type ${ctx.updateType}:`, err);
});

// ─────────────────────────────────────────────
// MARQUEE
// ─────────────────────────────────────────────

async function getMarquee(): Promise<string> {
  const result = await pool.query(
    `SELECT message, expires_at FROM marquee WHERE id = 1`
  );
  if (result.rows.length === 0) return "";
  const row = result.rows[0];
  if (row.expires_at && new Date(row.expires_at) < new Date()) return "";
  return row.message || "";
}

async function setMarquee(message: string, hours: number): Promise<void> {
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
  await pool.query(
    `INSERT INTO marquee (id, message, expires_at)
     VALUES (1, $1, $2)
     ON CONFLICT (id) DO UPDATE SET message = $1, expires_at = $2`,
    [message, expiresAt]
  );
}

function animateMarquee(text: string): string {
  return `📢 〈 ${text} 〉`;
}

async function buildHeader(): Promise<string> {
  const marquee = await getMarquee();
  if (!marquee) return "";
  return `${animateMarquee(marquee)}\n${"─".repeat(30)}\n`;
}

// ─────────────────────────────────────────────
// MENU AVAILABILITY & PRICE HELPERS
// ─────────────────────────────────────────────

async function getAvailability(): Promise<Record<string, boolean>> {
  const result = await pool.query(
    `SELECT item_id, available FROM menu_availability`
  );
  const map: Record<string, boolean> = {};
  for (const row of result.rows) {
    map[row.item_id] = row.available;
  }
  return map;
}

async function getPriceOverrides(): Promise<Record<string, number>> {
  const result = await pool.query(
    `SELECT item_id, price FROM menu_price_overrides`
  );
  const map: Record<string, number> = {};
  for (const row of result.rows) {
    map[row.item_id] = Number(row.price);
  }
  return map;
}

async function setPrice(itemId: string, price: number): Promise<void> {
  await pool.query(
    `INSERT INTO menu_price_overrides (item_id, price)
     VALUES ($1, $2)
     ON CONFLICT (item_id) DO UPDATE SET price = $2`,
    [itemId, price]
  );
}

async function getAvailableMenu() {
  const avail = await getAvailability();
  const prices = await getPriceOverrides();
  return MENU.filter((item) => avail[item.id] !== false).map((item) => ({
    ...item,
    price: prices[item.id] ?? item.price,
  }));
}

async function toggleAvailability(itemId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT available FROM menu_availability WHERE item_id = $1`,
    [itemId]
  );
  const current = result.rows.length === 0 ? true : result.rows[0].available;
  const next = !current;
  await pool.query(
    `INSERT INTO menu_availability (item_id, available)
     VALUES ($1, $2)
     ON CONFLICT (item_id) DO UPDATE SET available = $2`,
    [itemId, next]
  );
  return next;
}

// ─────────────────────────────────────────────
// MENU TEXT & KEYBOARDS
// ─────────────────────────────────────────────

async function buildMenuText(userId: number): Promise<string> {
  const header = await buildHeader();
  const cart = getCart(userId);
  let body = `🍽 እንኳን ደህና መጡ ወደ በምነት ሬስቶራንት!\n📍 ጎንደር፣ ማርኪ\n\nለማዘዝ ምግብ ይምረጡ:`;
  if (cart.length > 0) {
    const lines = cart.map(
      (i) => `• ${i.name} x${i.quantity} — ${i.price * i.quantity} ብር`
    );
    const total = cartTotal(userId);
    body = `🛒 የተመረጡ ምግቦች:\n${lines.join("\n")}\n\nድምር: ${total} ብር\n\n${"─".repeat(16)}\nለማዘዝ ምግብ ይምረጡ:`;
  }
  return header + body;
}

async function menuKeyboard() {
  const availableItems = await getAvailableMenu();
  const buttons = availableItems.map((item) =>
    Markup.button.callback(
      `${item.name} — ${item.price} ብር`,
      `add_${item.id}`
    )
  );
  const rows: any[] = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }
  rows.push([Markup.button.callback("🛒 የምግብ ዝርዝር ይመልከቱ", "view_cart")]);
  return Markup.inlineKeyboard(rows);
}

function cartKeyboard(userId: number) {
  const cart = getCart(userId);
  const rows: any[] = cart.map((item) => [
    Markup.button.callback(`${item.name} x${item.quantity}`, "noop"),
    Markup.button.callback("➖", `remove_${item.id}`),
    Markup.button.callback("➕", `add_${item.id}`),
  ]);
  rows.push([Markup.button.callback("✅ ትዕዛዝ ይፈጽሙ", "checkout")]);
  rows.push([Markup.button.callback("🍽 ወደ ምግብ ዝርዝር ተመለስ", "back_to_menu")]);
  return Markup.inlineKeyboard(rows);
}

async function manageMenuKeyboard() {
  const avail = await getAvailability();
  const prices = await getPriceOverrides();
  const rows: any[] = [];
  for (const item of MENU) {
    const isAvailable = avail[item.id] !== false;
    const icon = isAvailable ? "✅" : "❌";
    const price = prices[item.id] ?? item.price;
    rows.push([
      Markup.button.callback(
        `${icon} ${item.name} — ${price} ብር`,
        `toggle_${item.id}`
      ),
      Markup.button.callback("💰 ዋጋ ቀይር", `price_${item.id}`),
    ]);
  }
  rows.push([Markup.button.callback("✔️ ተጠናቋል", "manage_done")]);
  return Markup.inlineKeyboard(rows);
}

// ─────────────────────────────────────────────
// ADMIN HELPERS
// ─────────────────────────────────────────────

function isAdmin(userId: number) {
  return ADMIN_IDS.map(Number).includes(Number(userId));
}

// ─────────────────────────────────────────────
// DAILY RESET (runs every morning at 6:00 AM)
// ─────────────────────────────────────────────

function scheduleDailyReset() {
  function msUntil(hour: number, minute = 0): number {
    const now = new Date();
    const next = new Date();
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  }

  setTimeout(async () => {
    try {
      await pool.query(
        `UPDATE orders SET status = 'archived'
         WHERE status IN ('pending_payment', 'payment_submitted')
           AND created_at < CURRENT_DATE`
      );

      for (const adminId of ADMIN_IDS) {
        try {
          await bot.telegram.sendMessage(
            adminId,
            `🌅 እንኳን ደህና አደሩ!\n\nአዲስ ቀን ተጀምሯል — ትዕዛዞች ዳግም ጀምሯል። ✅`
          );
        } catch {}
      }

      console.log("Daily reset done.");
    } catch (err) {
      console.error("Daily reset error:", err);
    }

    scheduleDailyReset();
  }, msUntil(6, 0));
}

// ─────────────────────────────────────────────
// NIGHTLY REPORT (runs every night at 9:00 PM)
// ─────────────────────────────────────────────

function scheduleNightlyReport() {
  function msUntil(hour: number, minute = 0): number {
    const now = new Date();
    const next = new Date();
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  }

  setTimeout(async () => {
    try {
      await sendNightlyReport();
    } catch (err) {
      console.error("Nightly report error:", err);
    }
    scheduleNightlyReport();
  }, msUntil(21, 0));
}

async function sendNightlyReport() {
  const result = await pool.query(
    `SELECT
       o.id,
       o.customer_name,
       o.customer_phone,
       o.order_type,
       o.total_amount,
       o.status,
       o.created_at,
       STRING_AGG(oi.item_name || ' x' || oi.quantity, ', ') AS items
     FROM orders o
     LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE o.created_at >= CURRENT_DATE
       AND o.status IN ('payment_submitted', 'confirmed', 'pending_payment')
     GROUP BY o.id
     ORDER BY o.created_at ASC`
  );

  const orders = result.rows;
  const today = new Date().toLocaleDateString("en-GB");

  if (orders.length === 0) {
    for (const adminId of ADMIN_IDS) {
      try {
        await bot.telegram.sendMessage(
          adminId,
          `🌙 የምሽት ሪፖርት — ${today}\n\nዛሬ ምንም ትዕዛዝ አልተቀበለም።`
        );
      } catch {}
    }
    return;
  }

  const totalRevenue = orders.reduce(
    (sum: number, o: any) => sum + Number(o.total_amount),
    0
  );
  const confirmed = orders.filter((o: any) => o.status === "confirmed").length;
  const submitted = orders.filter(
    (o: any) => o.status === "payment_submitted"
  ).length;
  const pending = orders.filter(
    (o: any) => o.status === "pending_payment"
  ).length;

  const divider = `┼${"─".repeat(4)}┼${"─".repeat(14)}┼${"─".repeat(12)}┼${"─".repeat(10)}┼${"─".repeat(10)}┼`;
  const header  = `│ #  │ ደንበኛ         │ ስልክ        │ አይነት    │ ብር       │`;
  const top     = `┌${"─".repeat(4)}┬${"─".repeat(14)}┬${"─".repeat(12)}┬${"─".repeat(10)}┬${"─".repeat(10)}┐`;
  const bottom  = `└${"─".repeat(4)}┴${"─".repeat(14)}┴${"─".repeat(12)}┴${"─".repeat(10)}┴${"─".repeat(10)}┘`;

  const rows = orders.map((o: any) => {
    const name  = (o.customer_name  || "—").substring(0, 12).padEnd(12);
    const phone = (o.customer_phone || "—").substring(0, 10).padEnd(10);
    const type  = (o.order_type === "delivery" ? "ዴሊቨሪ" : "ፒክአፕ").padEnd(8);
    const amt   = String(o.total_amount).padEnd(8);
    const id    = String(o.id).padEnd(2);
    return `│ ${id} │ ${name} │ ${phone} │ ${type} │ ${amt} │`;
  });

  const statusLine = (emoji: string, label: string, count: number) =>
    `${emoji} ${label}: ${count} ትዕዛዝ`;

  const report =
    `🌙 *የምሽት ሪፖርት — ${today}*\n` +
    `${"═".repeat(34)}\n\n` +
    `📊 *ማጠቃለያ*\n` +
    `${statusLine("✅", "ተረጋግጧል", confirmed)}\n` +
    `${statusLine("💳", "ክፍያ ተልኳል", submitted)}\n` +
    `${statusLine("⏳", "ክፍያ ይጠበቃል", pending)}\n` +
    `💰 *ጠቅላላ ገቢ: ${totalRevenue} ብር*\n\n` +
    `📋 *የትዕዛዝ ዝርዝር*\n` +
    `\`\`\`\n` +
    `${top}\n` +
    `${header}\n` +
    `${divider}\n` +
    rows.join(`\n${divider}\n`) +
    `\n${bottom}\n` +
    `\`\`\`\n\n` +
    `🍽 *በምነት ሬስቶራንት — ጎንደር*`;

  for (const adminId of ADMIN_IDS) {
    try {
      await bot.telegram.sendMessage(adminId, report, {
        parse_mode: "Markdown",
      });
    } catch (err) {
      console.error(`Failed to send nightly report to admin ${adminId}:`, err);
    }
  }
}

// ─────────────────────────────────────────────
// COMMANDS
// ─────────────────────────────────────────────

bot.start(async (ctx) => {
  console.log("Telegram user ID:", ctx.from.id);
  clearCart(ctx.from.id);
  clearDraft(ctx.from.id);
  const availableItems = await getAvailableMenu();
  if (availableItems.length === 0) {
    const header = await buildHeader();
    return ctx.reply(
      header +
        `እንኳን ደህና መጡ ወደ በምነት ሬስቶራንት! 🍽\nጎንደር፣ ማርኪ\n\nየምግብ ዝርዝሩ አሁን አይገኝም። እባክዎ ቆየት ብለው ይሞክሩ!`
    );
  }
  ctx.reply(await buildMenuText(ctx.from.id), await menuKeyboard());
});

bot.command("menu", async (ctx) => {
  ctx.reply(await buildMenuText(ctx.from.id), await menuKeyboard());
});

bot.command("manage", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  ctx.reply(
    "የምግብ ዝርዝር ያስተዳድሩ — ለመቀየር ይጫኑ:",
    await manageMenuKeyboard()
  );
});

bot.command("confirm", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const orderId = parseInt(ctx.message.text.split(" ")[1], 10);
  if (!orderId) return ctx.reply("አጠቃቀም: /confirm <order_id>");
  await pool.query(`UPDATE orders SET status = 'confirmed' WHERE id = $1`, [
    orderId,
  ]);
  const orderResult = await pool.query(
    `SELECT * FROM orders WHERE id = $1`,
    [orderId]
  );
  const order = orderResult.rows[0];
  if (order) {
    await bot.telegram.sendMessage(
      order.customer_telegram_id,
      `ትዕዛዝ #${orderId} ተረጋግጧል! በምነት ሬስቶራንት እያዘጋጀ ነው። 🍽`
    );
  }
  ctx.reply(
    `✅ ትዕዛዝ #${orderId} ተረጋግጧል።\n\n💬 ለደንበኛው ለመልስ: /reply ${orderId} <መልዕክት>`
  );
});

bot.command("reply", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const parts = ctx.message.text.split(" ");
  if (parts.length < 3) {
    return ctx.reply(
      "አጠቃቀም: /reply <order_id> <መልዕክት>\nምሳሌ: /reply 42 ትዕዛዝዎ እየተዘጋጀ ነው!"
    );
  }

  const orderId = parseInt(parts[1], 10);
  if (isNaN(orderId)) {
    return ctx.reply("ትክክለኛ የትዕዛዝ ቁጥር ያስገቡ። ምሳሌ: /reply 42 መልዕክት");
  }

  const message = parts.slice(2).join(" ");

  const orderResult = await pool.query(
    `SELECT customer_telegram_id, customer_name FROM orders WHERE id = $1`,
    [orderId]
  );

  if (orderResult.rows.length === 0) {
    return ctx.reply(`ትዕዛዝ #${orderId} አልተገኘም።`);
  }

  const order = orderResult.rows[0];

  try {
    await bot.telegram.sendMessage(
      order.customer_telegram_id,
      `📨 *በምነት ሬስቶራንት:*\n\n${message}`,
      { parse_mode: "Markdown" }
    );
    ctx.reply(
      `✅ መልዕክት ለ ${order.customer_name} (ትዕዛዝ #${orderId}) ተልኳል።`
    );
  } catch (err) {
    console.error("Failed to send reply to customer:", err);
    ctx.reply(
      "❌ መልዕክት መላክ አልተቻለም። ደንበኛው ቦቱን አቁሞ ሊሆን ይችላል።"
    );
  }
});

bot.command("orders", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const result = await pool.query(
    `SELECT id, customer_name, order_type, total_amount, status, created_at
     FROM orders
     WHERE created_at >= CURRENT_DATE
     ORDER BY created_at DESC LIMIT 10`
  );
  if (result.rows.length === 0) return ctx.reply("ዛሬ ምንም ትዕዛዝ የለም።");
  const lines = result.rows.map(
    (o: any) =>
      `#${o.id} — ${o.customer_name} — ${o.order_type} — ${o.total_amount} ብር — ${o.status}`
  );
  ctx.reply(lines.join("\n"));
});

bot.command("report", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  await sendNightlyReport();
});

bot.command("setmarquee", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const parts = ctx.message.text.split(" ");
  if (parts.length < 3) {
    return ctx.reply(
      "አጠቃቀም: /setmarquee <ሰዓት> <መልዕክት>\nምሳሌ: /setmarquee 3 ዛሬ ልዩ ቅናሽ አለ!"
    );
  }
  const hours = parseFloat(parts[1]);
  if (isNaN(hours) || hours <= 0) {
    return ctx.reply(
      "እባክዎ ትክክለኛ ሰዓት ያስገቡ። ምሳሌ: /setmarquee 2 መልዕክት"
    );
  }
  const message = parts.slice(2).join(" ");
  await setMarquee(message, hours);
  ctx.reply(
    `✅ ማርኬ ተቀጥሏል!\n\n📢 "${message}"\n⏱ ለ ${hours} ሰዓት ይታያል።`
  );
});

bot.command("clearmarquee", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  await pool.query(
    `UPDATE marquee SET message = '', expires_at = NULL WHERE id = 1`
  );
  ctx.reply("✅ ማርኬ ተሰርዟል።");
});

// ─────────────────────────────────────────────
// ADMIN ACTIONS
// ─────────────────────────────────────────────

bot.action(/^toggle_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery("አልተፈቀደም።");
  const itemId = ctx.match[1];
  const newState = await toggleAvailability(itemId);
  const item = MENU.find((m) => m.id === itemId);
  await ctx.answerCbQuery(
    `${item?.name} አሁን ${newState ? "✅ አለ" : "❌ የለም"}`
  );
  try {
    await ctx.editMessageReplyMarkup(
      (await manageMenuKeyboard()).reply_markup
    );
  } catch {}
});

bot.action("manage_done", async (ctx) => {
  await ctx.answerCbQuery("ተጠናቋል!");
  try {
    await ctx.editMessageText("የምግብ ዝርዝር በተሳካ ሁኔታ ተዘምኗል። ✅");
  } catch {}
});

bot.action(/^price_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery("አልተፈቀደም።");
  const itemId = ctx.match[1];
  const item = MENU.find((m) => m.id === itemId);
  if (!item) return ctx.answerCbQuery("ምግቡ አልተገኘም።");
  adminPriceEdit.set(ctx.from.id, itemId);
  await ctx.answerCbQuery();
  await ctx.reply(`${item.name} አዲስ ዋጋ ያስገቡ (በቁጥር ብቻ):`);
});

// ─────────────────────────────────────────────
// CUSTOMER ACTIONS
// ─────────────────────────────────────────────

bot.action(/^add_(.+)$/, async (ctx) => {
  const itemId = ctx.match[1];
  const availableMenu = await getAvailableMenu();
  const item = availableMenu.find((m) => m.id === itemId);
  if (!item) return ctx.answerCbQuery("ይቅርታ፣ ይህ ምግብ አሁን አይገኝም።");
  addToCart(ctx.from.id, item);
  await ctx.answerCbQuery(`${item.name} ታክሏል ✅`);
  try {
    await ctx.editMessageText(
      await buildMenuText(ctx.from.id),
      await menuKeyboard()
    );
  } catch {}
});

bot.action(/^remove_(.+)$/, async (ctx) => {
  const itemId = ctx.match[1];
  removeFromCart(ctx.from.id, itemId);
  await ctx.answerCbQuery("ተወግዷል");
  await showCart(ctx);
});

bot.action("noop", async (ctx) => {
  await ctx.answerCbQuery();
});

bot.action("back_to_menu", async (ctx) => {
  await ctx.answerCbQuery();
  try {
    await ctx.editMessageText(
      await buildMenuText(ctx.from.id),
      await menuKeyboard()
    );
  } catch {}
});

bot.action("view_cart", async (ctx) => {
  await ctx.answerCbQuery();
  await showCart(ctx);
});

async function showCart(ctx: any) {
  const userId = ctx.from.id;
  const cart = getCart(userId);
  if (cart.length === 0) {
    try {
      return ctx.editMessageText(
        await buildMenuText(userId),
        await menuKeyboard()
      );
    } catch {
      return ctx.reply(await buildMenuText(userId), await menuKeyboard());
    }
  }
  const lines = cart.map(
    (i) => `• ${i.name} x${i.quantity} — ${i.price * i.quantity} ብር`
  );
  const total = cartTotal(userId);
  const header = await buildHeader();
  const text =
    header +
    `🛒 የምግብ ዝርዝርዎ:\n\n${lines.join("\n")}\n\nድምር: ${total} ብር`;
  try {
    await ctx.editMessageText(text, cartKeyboard(userId));
  } catch {
    await ctx.reply(text, cartKeyboard(userId));
  }
}

// ─────────────────────────────────────────────
// CHECKOUT FLOW
// ─────────────────────────────────────────────

bot.action("checkout", async (ctx) => {
  const userId = ctx.from.id;
  const cart = getCart(userId);
  if (cart.length === 0) {
    return ctx.answerCbQuery("የምግብ ዝርዝርዎ ባዶ ነው።");
  }
  await ctx.answerCbQuery();
  setDraft(userId, {});
  await ctx.reply(
    "ዴሊቨሪ ይፈልጋሉ ወይስ እራስዎ ይወስዳሉ?",
    Markup.inlineKeyboard([
      [Markup.button.callback("🚗 ዴሊቨሪ", "order_type_delivery")],
      [Markup.button.callback("🏪 እራሴ እወስዳለሁ", "order_type_pickup")],
    ])
  );
});

bot.action(/^order_type_(delivery|pickup)$/, async (ctx) => {
  const userId = ctx.from.id;
  const orderType = ctx.match[1] as "delivery" | "pickup";
  setDraft(userId, { ...getDraft(userId), orderType });
  await ctx.answerCbQuery();
  if (orderType === "delivery") {
    await ctx.reply("እባክዎ ያሉበትን አድራሻዎን ይላኩ:");
  } else {
    await ctx.reply("እባክዎ ሙሉ ስምዎን ይላኩ:");
  }
});

// ─────────────────────────────────────────────
// TEXT HANDLER
// ─────────────────────────────────────────────

bot.on("text", async (ctx) => {
  const userId = ctx.from.id;

  // Admin price editing takes priority
  if (isAdmin(userId) && adminPriceEdit.has(userId)) {
    const itemId = adminPriceEdit.get(userId)!;
    const raw = ctx.message.text.trim();
    if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
      return ctx.reply("እባክዎ ትክክለኛ ዋጋ (አዎንታዊ ቁጥር) ያስገቡ:");
    }
    await setPrice(itemId, Number(raw));
    adminPriceEdit.delete(userId);
    const item = MENU.find((m) => m.id === itemId);
    return ctx.reply(`${item?.name} ዋጋ ወደ ${raw} ብር ተቀይሯል ✅`);
  }

  // Customer checkout flow
  const draft = getDraft(userId);
  if (!draft.orderType) return;

  if (draft.orderType === "delivery" && !draft.deliveryAddress) {
    setDraft(userId, { ...draft, deliveryAddress: ctx.message.text });
    return ctx.reply("እባክዎ ሙሉ ስምዎን ይላኩ:");
  }

  if (!draft.customerName) {
    setDraft(userId, { ...draft, customerName: ctx.message.text });
    return ctx.reply("እባክዎ ስልክ ቁጥርዎን ይላኩ:");
  }

  if (!draft.customerPhone) {
    const phone = ctx.message.text.trim();
    if (!/^(09|07)\d{8}$/.test(phone)) {
      return ctx.reply(
        "የስልክ ቁጥሩ ትክክል አይደለም። ቁጥሩ በ09 ወይም 07 መጀመር እና 10 አሃዝ መሆን አለበት። እባክዎ እንደገና ይላኩ:"
      );
    }
    const updatedDraft = { ...draft, customerPhone: phone };
    setDraft(userId, updatedDraft);
    await finalizeOrder(ctx, updatedDraft);
    return;
  }
});

// ─────────────────────────────────────────────
// FINALIZE ORDER
// ─────────────────────────────────────────────

async function finalizeOrder(ctx: any, draft: ReturnType<typeof getDraft>) {
  const userId = ctx.from.id;
  const cart = getCart(userId);
  const total = cartTotal(userId);

  const result = await pool.query(
    `INSERT INTO orders (customer_telegram_id, customer_name, customer_phone, order_type, delivery_address, total_amount, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending_payment') RETURNING id`,
    [
      userId,
      draft.customerName,
      draft.customerPhone,
      draft.orderType,
      draft.deliveryAddress ?? null,
      total,
    ]
  );
  const orderId = result.rows[0].id;

  for (const item of cart) {
    await pool.query(
      `INSERT INTO order_items (order_id, item_id, item_name, item_price, quantity)
       VALUES ($1, $2, $3, $4, $5)`,
      [orderId, item.id, item.name, item.price, item.quantity]
    );
  }

  setDraft(userId, { ...draft, awaitingScreenshotFor: orderId });

  const summary = cart
    .map((i) => `• ${i.name} x${i.quantity} — ${i.price * i.quantity} ብር`)
    .join("\n");

  await ctx.reply(
    `ትዕዛዝ #${orderId} ተቀብለናል! ✅\n\n${summary}\n\nድምር: ${total} ብር\n\n` +
      `እባክዎ ወደ ሂሳብ ቁጥሩ ያስተላልፉ:\n🏦 የኢትዮጵያ ንግድ ባንክ (CBE)\n` +
      `ሂሳብ ቁጥር: ${RESTAURANT.bank.account}\n` +
      `ስም: ${RESTAURANT.bank.accountName}\n\n` +
      `ክፍያ ከፈጸሙ በኋላ የክፍያ ስክሪንሾት እዚህ ይላኩ።`
  );

  clearCart(userId);
}

// ─────────────────────────────────────────────
// PAYMENT SCREENSHOT
// ─────────────────────────────────────────────

bot.on("photo", async (ctx) => {
  const userId = ctx.from.id;
  const draft = getDraft(userId);
  if (!draft.awaitingScreenshotFor) {
    return ctx.reply("ፎቶ አልጠበቅሁም። ለማዘዝ /menu ይጫኑ።");
  }

  const orderId = draft.awaitingScreenshotFor;
  const photos = ctx.message.photo;
  const fileId = photos[photos.length - 1].file_id;

  await pool.query(
    `UPDATE orders SET payment_screenshot_file_id = $1, status = 'payment_submitted' WHERE id = $2`,
    [fileId, orderId]
  );

  await ctx.reply(
    `እናመሰግናለን! የክፍያ ስክሪንሾትዎ ለትዕዛዝ #${orderId} ደርሷል። በምነት ሬስቶራንት በቅርቡ ያረጋግጥልዎታል። 🙏`
  );

  const orderResult = await pool.query(
    `SELECT * FROM orders WHERE id = $1`,
    [orderId]
  );
  const order = orderResult.rows[0];
  const itemsResult = await pool.query(
    `SELECT * FROM order_items WHERE order_id = $1`,
    [orderId]
  );
  const items = itemsResult.rows;
  const itemLines = items
    .map(
      (i: any) =>
        `• ${i.item_name} x${i.quantity} — ${i.item_price * i.quantity} ብር`
    )
    .join("\n");

  const orderTypeLine =
    order.order_type === "delivery"
      ? `🚗 ዴሊቨሪ አድራሻ: ${order.delivery_address}`
      : `🏪 እራሱ ይወስዳል — ${RESTAURANT.location}`;

  const adminText =
    `🆕 አዲስ ትዕዛዝ #${order.id} — ክፍያ ተልኳል\n\n` +
    `👤 ${order.customer_name}\n📞 ${order.customer_phone}\n${orderTypeLine}\n\n` +
    `${itemLines}\n\nድምር: ${order.total_amount} ብር\n\n` +
    `💬 ለደንበኛው ለመልስ: /reply ${order.id} <መልዕክት>`;

  for (const adminId of ADMIN_IDS) {
    try {
      await bot.telegram.sendPhoto(adminId, fileId, { caption: adminText });
    } catch (err) {
      console.error(`Failed to notify admin ${adminId}:`, err);
    }
  }

  clearDraft(userId);
});

// ─────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────

initDb()
  .then(() => bot.launch({ dropPendingUpdates: true }))
  .then(() => {
    console.log(`${RESTAURANT.name} bot is running.`);
    scheduleDailyReset();
    scheduleNightlyReport();
  })
  .catch((err) => console.error("Startup error:", err));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
