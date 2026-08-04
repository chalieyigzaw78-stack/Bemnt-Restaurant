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
if (!BOT_TOKEN) throw new Error("BOT_TOKEN is not set.");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const bot = new Telegraf(BOT_TOKEN);

bot.catch((err, ctx) => {
  console.error(`Bot error for update type ${ctx.updateType}:`, err);
});

// --- Menu availability helpers ---

async function getAvailability(): Promise<Record<string, boolean>> {
  const result = await pool.query(`SELECT item_id, available FROM menu_availability`);
  const map: Record<string, boolean> = {};
  for (const row of result.rows) {
    map[row.item_id] = row.available;
  }
  return map;
}

async function getAvailableMenu() {
  const avail = await getAvailability();
  return MENU.filter((item) => avail[item.id] !== false);
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

// --- Price editing helper ---

async function getPrice(itemId: string): Promise<number> {
  const result = await pool.query(
    `SELECT price FROM menu_prices WHERE item_id = $1`,
    [itemId]
  );
  if (result.rows.length > 0) return result.rows[0].price;
  const item = MENU.find((m) => m.id === itemId);
  return item?.price ?? 0;
}

async function getFullMenu() {
  const avail = await getAvailability();
  const prices = await pool.query(`SELECT item_id, price FROM menu_prices`);
  const priceMap: Record<string, number> = {};
  for (const row of prices.rows) {
    priceMap[row.item_id] = row.price;
  }
  return MENU.map((item) => ({
    ...item,
    price: priceMap[item.id] ?? item.price,
    available: avail[item.id] !== false,
  }));
}

async function getAvailableMenuWithPrices() {
  const full = await getFullMenu();
  return full.filter((item) => item.available);
}

// --- Payment screenshot verification via Claude Vision ---

async function verifyPaymentScreenshot(fileId: string): Promise<boolean> {
  if (!ANTHROPIC_API_KEY) {
    console.warn("No ANTHROPIC_API_KEY set — skipping screenshot verification.");
    return true;
  }

  try {
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${await getFilePath(fileId)}`;
    const imageResp = await fetch(fileUrl);
    const arrayBuffer = await imageResp.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    const mimeType = "image/jpeg";

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 200,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: mimeType, data: base64 },
              },
              {
                type: "text",
                text: `Look at this image carefully. 
Answer ONLY with "VALID" or "INVALID".

Answer VALID if ALL of these are true:
1. The image looks like a bank transfer or mobile payment receipt/screenshot
2. It contains at least one of these words (case insensitive): "Chalie", "Yigzaw", or "Assfaw"

Answer INVALID if either condition is not met.

Reply with ONLY the single word VALID or INVALID, nothing else.`,
              },
            ],
          },
        ],
      }),
    });

    const data = await response.json();
    const answer = data?.content?.[0]?.text?.trim().toUpperCase();
    console.log("Screenshot verification result:", answer);
    return answer === "VALID";
  } catch (err) {
    console.error("Screenshot verification error:", err);
    return true;
  }
}

async function getFilePath(fileId: string): Promise<string> {
  const resp = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`
  );
  const data = await resp.json();
  return data.result.file_path;
}

// --- Phone validation ---

function isValidPhone(phone: string): boolean {
  const cleaned = phone.replace(/\s+/g, "");
  return /^(09|07)\d{8}$/.test(cleaned);
}

// --- Menu text with cart preview ---

function buildMenuText(userId: number, items: { name: string; price: number }[]): string {
  const cart = getCart(userId);
  let text = `🍽 እንኳን ደህና መጡ ወደ በምነት ሬስቶራንት!\n📍 ጎንደር፣ ማርኪ\n\nለማዘዝ ምግብ ይምረጡ:`;
  if (cart.length > 0) {
    const lines = cart.map((i) => `• ${i.name} x${i.quantity} — ${i.price * i.quantity} ብር`);
    const total = cartTotal(userId);
    text = `🛒 የተመረጡ ምግቦች:\n${lines.join("\n")}\n\nድምር: ${total} ብር\n\n────────────────\nለማዘዝ ምግብ ይምረጡ:`;
  }
  return text;
}

// --- Keyboards ---

async function menuKeyboard(userId: number) {
  const availableItems = await getAvailableMenuWithPrices();
  const buttons = availableItems.map((item) =>
    Markup.button.callback(`${item.name} — ${item.price} ብር`, `add_${item.id}`)
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
  const full = await getFullMenu();
  const rows: any[] = full.map((item) => {
    const icon = item.available ? "✅" : "❌";
    return [
      Markup.button.callback(
        `${icon} ${item.name} — ${item.price} ብር`,
        `toggle_${item.id}`
      ),
    ];
  });
  rows.push([Markup.button.callback("✔️ ተጠናቋል", "manage_done")]);
  return Markup.inlineKeyboard(rows);
}

// --- Admin check ---

function isAdmin(userId: number) {
  return ADMIN_IDS.map(Number).includes(Number(userId));
}

// --- Commands ---

bot.start(async (ctx) => {
  console.log("Telegram user ID:", ctx.from.id);
  clearCart(ctx.from.id);
  clearDraft(ctx.from.id);
  const availableItems = await getAvailableMenuWithPrices();
  if (availableItems.length === 0) {
    return ctx.reply(
      `እንኳን ደህና መጡ ወደ በምነት ሬስቶራንት! 🍽\nጎንደር፣ ማርኪ\n\nየምግብ ዝርዝሩ አሁን አይገኝም። እባክዎ ቆየት ብለው ይሞክሩ!`
    );
  }
  ctx.reply(buildMenuText(ctx.from.id, availableItems), await menuKeyboard(ctx.from.id));
});

bot.command("menu", async (ctx) => {
  const availableItems = await getAvailableMenuWithPrices();
  ctx.reply(buildMenuText(ctx.from.id, availableItems), await menuKeyboard(ctx.from.id));
});

bot.command("manage", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  ctx.reply("የምግብ ዝርዝር ያስተዳድሩ — ለመቀየር ይጫኑ:", await manageMenuKeyboard());
});

bot.command("setprice", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const parts = ctx.message.text.split(" ");
  if (parts.length !== 3) return ctx.reply("አጠቃቀም: /setprice <item_id> <ዋጋ>\nምሳሌ: /setprice tibs 550");
  const itemId = parts[1].toLowerCase();
  const newPrice = parseInt(parts[2], 10);
  if (isNaN(newPrice) || newPrice <= 0) return ctx.reply("ዋጋው ትክክል አይደለም።");
  const item = MENU.find((m) => m.id === itemId);
  if (!item) {
    const ids = MENU.map((m) => m.id).join(", ");
    return ctx.reply(`ምግቡ አልተገኘም። ትክክለኛ ID ይጠቀሙ:\n${ids}`);
  }
  await pool.query(
    `INSERT INTO menu_prices (item_id, price)
     VALUES ($1, $2)
     ON CONFLICT (item_id) DO UPDATE SET price = $2`,
    [itemId, newPrice]
  );
  ctx.reply(`✅ ${item.name} ዋጋ ወደ ${newPrice} ብር ተቀይሯል።`);
});

bot.command("confirm", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const orderId = parseInt(ctx.message.text.split(" ")[1], 10);
  if (!orderId) return ctx.reply("አጠቃቀም: /confirm <order_id>");
  await pool.query(`UPDATE orders SET status = 'confirmed' WHERE id = $1`, [orderId]);
  const orderResult = await pool.query(`SELECT * FROM orders WHERE id = $1`, [orderId]);
  const order = orderResult.rows[0];
  if (order) {
    await bot.telegram.sendMessage(
      order.customer_telegram_id,
      `ትዕዛዝ #${orderId} ተረጋግጧል! በምነት ሬስቶራንት እያዘጋጀ ነው። 🍽`
    );
  }
  ctx.reply(`ትዕዛዝ #${orderId} ተረጋግጧል።`);
});

bot.command("cancel", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const orderId = parseInt(ctx.message.text.split(" ")[1], 10);
  if (!orderId) return ctx.reply("አጠቃቀም: /cancel <order_id>");
  await pool.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [orderId]);
  const orderResult = await pool.query(`SELECT * FROM orders WHERE id = $1`, [orderId]);
  const order = orderResult.rows[0];
  if (order) {
    await bot.telegram.sendMessage(
      order.customer_telegram_id,
      `ትዕዛዝ #${orderId} ተሰርዟል። ለበለጠ መረጃ በምነት ሬስቶራንትን ያግኙ። 📞 ${RESTAURANT.phone}`
    );
  }
  ctx.reply(`ትዕዛዝ #${orderId} ተሰርዟል።`);
});

bot.command("orders", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const result = await pool.query(
    `SELECT id, customer_name, order_type, total_amount, status, created_at FROM orders ORDER BY created_at DESC LIMIT 10`
  );
  if (result.rows.length === 0) return ctx.reply("እስካሁን ምንም ትዕዛዝ የለም።");
  const lines = result.rows.map(
    (o: any) =>
      `#${o.id} — ${o.customer_name} — ${o.order_type} — ${o.total_amount} ብር — ${o.status}`
  );
  ctx.reply(lines.join("\n"));
});

// --- Menu toggle (admin) ---

bot.action(/^toggle_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery("አልተፈቀደም።");
  const itemId = ctx.match[1];
  const newState = await toggleAvailability(itemId);
  const item = MENU.find((m) => m.id === itemId);
  await ctx.answerCbQuery(`${item?.name} አሁን ${newState ? "✅ አለ" : "❌ የለም"}`);
  try {
    await ctx.editMessageReplyMarkup((await manageMenuKeyboard()).reply_markup);
  } catch {}
});

bot.action("manage_done", async (ctx) => {
  await ctx.answerCbQuery("ተጠናቋል!");
  try {
    await ctx.editMessageText("የምግብ ዝርዝር በተሳካ ሁኔታ ተዘምኗል። ✅");
  } catch {}
});

// --- Menu interactions (customers) ---

bot.action(/^add_(.+)$/, async (ctx) => {
  const itemId = ctx.match[1];
  const availableItems = await getAvailableMenuWithPrices();
  const item = availableItems.find((m) => m.id === itemId);
  if (!item) return ctx.answerCbQuery("ይቅርታ፣ ይህ ምግብ አሁን አይገኝም።");
  addToCart(ctx.from.id, item);
  await ctx.answerCbQuery(`${item.name} ታክሏል ✅`);
  try {
    await ctx.editMessageText(
      buildMenuText(ctx.from.id, availableItems),
      await menuKeyboard(ctx.from.id)
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
  const availableItems = await getAvailableMenuWithPrices();
  try {
    await ctx.editMessageText(
      buildMenuText(ctx.from.id, availableItems),
      await menuKeyboard(ctx.from.id)
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
  const availableItems = await getAvailableMenuWithPrices();
  if (cart.length === 0) {
    try {
      return ctx.editMessageText(buildMenuText(userId, availableItems), await menuKeyboard(userId));
    } catch {
      return ctx.reply(buildMenuText(userId, availableItems), await menuKeyboard(userId));
    }
  }
  const lines = cart.map((i) => `• ${i.name} x${i.quantity} — ${i.price * i.quantity} ብር`);
  const total = cartTotal(userId);
  const text = `🛒 የምግብ ዝርዝርዎ:\n\n${lines.join("\n")}\n\nድምር: ${total} ብር`;
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
  if (cart.length === 0) return ctx.answerCbQuery("የምግብ ዝርዝርዎ ባዶ ነው።");
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

bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
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
    const phone = ctx.message.text.replace(/\s+/g, "");
    if (!isValidPhone(phone)) {
      return ctx.reply(
        "❌ ስልክ ቁጥሩ ትክክል አይደለም።\nቁጥሩ በ 09 ወይም 07 መጀመር እና ትክክለኛ 10 አሃዝ መሆን አለበት።\nምሳሌ: 0911223344\n\nእባክዎ እንደገና ይሞክሩ:"
      );
    }
    const updatedDraft = { ...draft, customerPhone: phone };
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

// --- Handle payment screenshot ---

bot.on("photo", async (ctx) => {
  const userId = ctx.from.id;
  const draft = getDraft(userId);
  if (!draft.awaitingScreenshotFor) {
    return ctx.reply("ፎቶ አልጠበቅሁም። ለማዘዝ /menu ይጫኑ።");
  }

  const orderId = draft.awaitingScreenshotFor;
  const photos = ctx.message.photo;
  const fileId = photos[photos.length - 1].file_id;

  await ctx.reply("⏳ ክፍያዎን እየተረጋገጠ ነው፣ እባክዎ ይጠብቁ...");

  const isValid = await verifyPaymentScreenshot(fileId);

  if (!isValid) {
    return ctx.reply(
      "❌ ልክ ያልሆነ ክፍያ !! እባኮ ትክክለኛውን ክፍያ መላኮን ያረጋግጡ እና እንደገና ይሞክሩ።"
    );
  }

  await pool.query(
    `UPDATE orders SET payment_screenshot_file_id = $1, status = 'payment_submitted' WHERE id = $2`,
    [fileId, orderId]
  );

  await ctx.reply(
    `እናመሰግናለን! የክፍያ ስክሪንሾትዎ ለትዕዛዝ #${orderId} ደርሷል። በምነት ሬስቶራንት በቅርቡ ያረጋግጥልዎታል። 🙏`
  );

  const orderResult = await pool.query(`SELECT * FROM orders WHERE id = $1`, [orderId]);
  const order = orderResult.rows[0];
  const itemsResult = await pool.query(`SELECT * FROM order_items WHERE order_id = $1`, [orderId]);
  const items = itemsResult.rows;
  const itemLines = items
    .map((i: any) => `• ${i.item_name} x${i.quantity} — ${i.item_price * i.quantity} ብር`)
    .join("\n");

  const orderTypeLine =
    order.order_type === "delivery"
      ? `🚗 ዴሊቨሪ አድራሻ: ${order.delivery_address}`
      : `🏪 እራሱ ይወስዳል — ${RESTAURANT.location}`;

  const adminText =
    `🆕 አዲስ ትዕዛዝ #${order.id} — ክፍያ ተልኳል\n\n` +
    `👤 ${order.customer_name}\n📞 ${order.customer_phone}\n${orderTypeLine}\n\n` +
    `${itemLines}\n\nድምር: ${order.total_amount} ብር`;

  for (const adminId of ADMIN_IDS) {
    try {
      await bot.telegram.sendPhoto(adminId, fileId, { caption: adminText });
    } catch (err) {
      console.error(`Failed to notify admin ${adminId}:`, err);
    }
  }

  clearDraft(userId);
});

// --- Startup ---

initDb()
  .then(() => bot.launch({ dropPendingUpdates: true }))
  .then(() => console.log(`${RESTAURANT.name} bot is running.`))
  .catch((err) => console.error("Startup error:", err));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
