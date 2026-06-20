const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const app = express();
app.use(express.json());

// ─── CONFIG (set these as environment variables on Render) ─────────────────
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "my_xerox_bot_token";
const WA_TOKEN      = process.env.WA_TOKEN      || "YOUR_WHATSAPP_TOKEN";
const PHONE_ID       = process.env.PHONE_ID       || "YOUR_PHONE_NUMBER_ID";
const OWNER_PHONE    = process.env.OWNER_PHONE    || "91XXXXXXXXXX";
const UPSTASH_URL    = process.env.UPSTASH_URL    || "";
const UPSTASH_TOKEN  = process.env.UPSTASH_TOKEN  || "";
// ──────────────────────────────────────────────────────────────────────────

// ─── PRICE LIST — hidden from customers, used only for backend calculation ─
const RATES = {
  bwPerPage: 3,
  colorPlain: {
    tier1: { max: 10, rate: 10 },
    tier2: { max: 30, rate: 7 },
    tier3: { max: Infinity, rate: 6 }
  },
  spiralBinding: 50,
  hardBinding: 230
  // Lamination (Card ₹20 / A4 ₹30) and Glossy Color (₹30/page) are handled
  // manually in-shop, not tracked by the bot — mentioned only as an upsell
  // in the order-confirmation message.
};

function colorPlainRate(totalPrints) {
  if (totalPrints <= RATES.colorPlain.tier1.max) return RATES.colorPlain.tier1.rate;
  if (totalPrints <= RATES.colorPlain.tier2.max) return RATES.colorPlain.tier2.rate;
  return RATES.colorPlain.tier3.rate;
}

function calculatePrice(data) {
  const pages = parseInt(data.pages) || 1;
  const copies = parseInt(data.copies) || 1;
  const totalPrints = pages * copies;

  let printCost = 0;
  if (data.printType === "bw") printCost = totalPrints * RATES.bwPerPage;
  else if (data.printType === "color") printCost = totalPrints * colorPlainRate(totalPrints);

  let bindingCost = 0;
  if (data.binding === "spiral") bindingCost = RATES.spiralBinding;
  else if (data.binding === "hard") bindingCost = RATES.hardBinding;

  const total = printCost + bindingCost;
  return { totalPrints, printCost, bindingCost, total };
}

// Parses things like "1-5, 8, 10" into a page count. Returns null if unclear.
function parsePageRange(str) {
  try {
    const parts = str.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return null;
    let total = 0;
    for (const part of parts) {
      if (part.includes("-")) {
        const [a, b] = part.split("-").map((n) => parseInt(n.trim()));
        if (isNaN(a) || isNaN(b) || b < a) return null;
        total += b - a + 1;
      } else {
        const n = parseInt(part);
        if (isNaN(n)) return null;
        total += 1;
      }
    }
    return total > 0 ? total : null;
  } catch {
    return null;
  }
}

// ─── PERSISTENT DAILY STATS (Upstash Redis REST API) ───────────────────────
function todayKeyIST() {
  const dateStr = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  return `daily:${dateStr}`;
}

async function upstash(cmdPath) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  try {
    const res = await axios.get(`${UPSTASH_URL}/${cmdPath}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    return res.data?.result;
  } catch (err) {
    console.error("Upstash error:", err.message);
    return null;
  }
}

async function recordOrderStats(totalPrints, amount) {
  const key = todayKeyIST();
  await upstash(`hincrby/${key}/orders/1`);
  await upstash(`hincrby/${key}/prints/${totalPrints}`);
  await upstash(`hincrby/${key}/amount/${amount}`);
}

async function getTodayStats() {
  const key = todayKeyIST();
  const result = await upstash(`hgetall/${key}`);
  const stats = { orders: 0, prints: 0, amount: 0 };
  if (Array.isArray(result)) {
    for (let i = 0; i < result.length; i += 2) {
      stats[result[i]] = parseInt(result[i + 1]) || 0;
    }
  }
  return stats;
}

// ─── Session store ───────────────────────────────────────────────────────
const sessions = {};
function getSession(phone) {
  if (!sessions[phone]) sessions[phone] = { step: "WELCOME", data: {} };
  return sessions[phone];
}

async function sendMessage(to, text) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${PHONE_ID}/messages`,
    { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
    { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
  );
}

async function sendButtons(to, body, buttons) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${PHONE_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body },
        action: { buttons: buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) },
      },
    },
    { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
  );
}

function buildCustomerSummary(data) {
  const lines = [
    `📋 *ORDER SUMMARY*`,
    `─────────────`,
    `📄 File: ${data.file}`,
    `🎨 ${data.printType === "bw" ? "Black & White" : "Color"}`,
    `📃 Pages: ${data.pages}`,
    `🔢 Copies: ${data.copies}`,
    `📐 Size: ${data.size}`,
  ];
  if (data.binding) lines.push(`📚 Binding: ${data.binding === "spiral" ? "Spiral" : "Hard Binding"}`);
  lines.push(`🚚 ${data.delivery}`);
  if (data.address) lines.push(`📍 ${data.address}`);
  if (data.payment) lines.push(`💳 ${data.payment}`);
  lines.push(`─────────────`, `Confirm?`);
  return lines.join("\n");
}

async function handleMessage(phone, msgType, msgBody) {
  const session = getSession(phone);
  const { step, data } = session;

  if (step === "WELCOME") {
    await sendButtons(phone, `👋 Welcome to *PrintEasy*! What do you need?`, [
      { id: "svc_print", title: "🖨️ Print" },
      { id: "svc_binding", title: "📚 Binding" },
    ]);
    session.step = "ASK_SERVICE";
    return;
  }

  if (step === "ASK_SERVICE") {
    if (msgBody === "svc_print" || msgBody === "svc_binding") {
      data.service = msgBody === "svc_binding" ? "binding" : "print";
      await sendMessage(phone, `📎 Send your document (PDF/Word/Image)`);
      session.step = "ASK_FILE";
    } else {
      await sendButtons(phone, `Please choose:`, [
        { id: "svc_print", title: "🖨️ Print" },
        { id: "svc_binding", title: "📚 Binding" },
      ]);
    }
    return;
  }

  if (step === "ASK_FILE") {
    if (msgType === "document" || msgType === "image") {
      data.file = `Received (${msgType})`;
      await sendButtons(phone, `B&W or Color?`, [
        { id: "color_bw", title: "⬛ B&W" },
        { id: "color_color", title: "🌈 Color" },
      ]);
      session.step = "ASK_COLOR";
    } else {
      await sendMessage(phone, `Please send a document or image 📎`);
    }
    return;
  }

  if (step === "ASK_COLOR") {
    if (msgBody === "color_bw" || msgBody === "color_color") {
      data.printType = msgBody === "color_color" ? "color" : "bw";
      await sendButtons(phone, `Print which pages?`, [
        { id: "pg_all", title: "All Pages" },
        { id: "pg_specific", title: "Specific Pages" },
      ]);
      session.step = "ASK_PAGE_MODE";
    } else {
      await sendButtons(phone, `Please choose:`, [
        { id: "color_bw", title: "⬛ B&W" },
        { id: "color_color", title: "🌈 Color" },
      ]);
    }
    return;
  }

  if (step === "ASK_PAGE_MODE") {
    if (msgBody === "pg_all") {
      await sendMessage(phone, `How many pages in total?`);
      session.step = "ASK_PAGE_COUNT";
    } else if (msgBody === "pg_specific") {
      await sendMessage(phone, `Which pages? (e.g. 1-5, 8, 10)`);
      session.step = "ASK_SPECIFIC_PAGES";
    } else {
      await sendButtons(phone, `Please choose:`, [
        { id: "pg_all", title: "All Pages" },
        { id: "pg_specific", title: "Specific Pages" },
      ]);
    }
    return;
  }

  if (step === "ASK_SPECIFIC_PAGES") {
    const count = parsePageRange(msgBody || "");
    if (count) {
      data.pages = count;
      data.pageRange = msgBody;
      await sendMessage(phone, `🔢 How many copies (sets)?`);
      session.step = "ASK_COPIES";
    } else {
      await sendMessage(phone, `Couldn't read that — how many pages total? (number)`);
      session.step = "ASK_PAGE_COUNT";
    }
    return;
  }

  if (step === "ASK_PAGE_COUNT") {
    const num = parseInt(msgBody);
    if (!isNaN(num) && num > 0) {
      data.pages = num;
      await sendMessage(phone, `🔢 How many copies (sets)?`);
      session.step = "ASK_COPIES";
    } else {
      await sendMessage(phone, `Please enter a valid number (e.g. 5)`);
    }
    return;
  }

  if (step === "ASK_COPIES") {
    const num = parseInt(msgBody);
    if (!isNaN(num) && num > 0) {
      data.copies = num;
      await sendButtons(phone, `Paper size?`, [
        { id: "size_a4", title: "A4" },
        { id: "size_a3", title: "A3" },
        { id: "size_letter", title: "Letter" },
      ]);
      session.step = "ASK_SIZE";
    } else {
      await sendMessage(phone, `Please enter a valid number (e.g. 2)`);
    }
    return;
  }

  if (step === "ASK_SIZE") {
    const sizeMap = { size_a4: "A4", size_a3: "A3", size_letter: "Letter" };
    if (sizeMap[msgBody]) {
      data.size = sizeMap[msgBody];
      if (data.service === "binding") {
        await sendButtons(phone, `Binding type?`, [
          { id: "bind_spiral", title: "📎 Spiral" },
          { id: "bind_hard", title: "📕 Hard Binding" },
        ]);
        session.step = "ASK_BINDING_TYPE";
      } else {
        await askDelivery(phone, session);
      }
    } else {
      await sendButtons(phone, `Please choose:`, [
        { id: "size_a4", title: "A4" },
        { id: "size_a3", title: "A3" },
        { id: "size_letter", title: "Letter" },
      ]);
    }
    return;
  }

  if (step === "ASK_BINDING_TYPE") {
    if (msgBody === "bind_spiral" || msgBody === "bind_hard") {
      data.binding = msgBody === "bind_hard" ? "hard" : "spiral";
      await askDelivery(phone, session);
    } else {
      await sendButtons(phone, `Please choose:`, [
        { id: "bind_spiral", title: "📎 Spiral" },
        { id: "bind_hard", title: "📕 Hard Binding" },
      ]);
    }
    return;
  }

  if (step === "ASK_DELIVERY") {
    if (msgBody === "del_pickup") {
      data.delivery = "Pickup";
      await showSummary(phone, session);
    } else if (msgBody === "del_delivery") {
      data.delivery = "Home Delivery";
      await sendMessage(phone, `🚚 *Delivery slots:* 3–4 PM or 8–9 PM only.`);
      await sendMessage(phone, `📍 Your delivery address?`);
      session.step = "ASK_ADDRESS";
    } else {
      await sendButtons(phone, `Please choose:`, [
        { id: "del_pickup", title: "🏪 Pickup" },
        { id: "del_delivery", title: "🚚 Delivery" },
      ]);
    }
    return;
  }

  if (step === "ASK_ADDRESS") {
    data.address = msgBody;
    await sendButtons(phone, `Payment method?`, [
      { id: "pay_cash", title: "💵 Cash" },
      { id: "pay_upi", title: "📱 UPI" },
    ]);
    session.step = "ASK_PAYMENT";
    return;
  }

  if (step === "ASK_PAYMENT") {
    const payMap = { pay_cash: "Cash", pay_upi: "UPI" };
    if (payMap[msgBody]) {
      data.payment = payMap[msgBody];
      await showSummary(phone, session);
    } else {
      await sendButtons(phone, `Please choose:`, [
        { id: "pay_cash", title: "💵 Cash" },
        { id: "pay_upi", title: "📱 UPI" },
      ]);
    }
    return;
  }

  if (step === "CONFIRM") {
    if (msgBody === "confirm_yes") {
      const priced = calculatePrice(data);
      await recordOrderStats(priced.totalPrints, priced.total);
      await sendMessage(
        phone,
        `✅ *Order Received!* We'll notify you when it's ready.\n\nWe also offer Lamination (Card/A4) — visit us in-shop! ✨`
      );
      sessions[phone] = { step: "DONE", data: {} };
    } else {
      sessions[phone] = { step: "WELCOME", data: {} };
      await handleMessage(phone, "text", "start");
    }
    return;
  }

  if (step === "DONE") {
    sessions[phone] = { step: "WELCOME", data: {} };
    await handleMessage(phone, "text", "start");
  }
}

async function askDelivery(phone, session) {
  await sendButtons(phone, `Pickup or delivery?`, [
    { id: "del_pickup", title: "🏪 Pickup" },
    { id: "del_delivery", title: "🚚 Delivery" },
  ]);
  session.step = "ASK_DELIVERY";
}

async function showSummary(phone, session) {
  await sendMessage(phone, buildCustomerSummary(session.data));
  await sendButtons(phone, `Is this correct?`, [
    { id: "confirm_yes", title: "✅ Yes" },
    { id: "confirm_no", title: "❌ Start Over" },
  ]);
  session.step = "CONFIRM";
}

// ─── DAILY REPORT — 9 PM IST, to OWNER_PHONE, numbers only ─────────────────
async function sendDailyReport() {
  const stats = await getTodayStats();
  const dateStr = new Date().toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata" });
  const msg =
    `📊 *DAILY REPORT — ${dateStr}*\n` +
    `─────────────────────\n` +
    `Orders: ${stats.orders}\n` +
    `Total Prints: ${stats.prints}\n` +
    `Total Amount: ₹${stats.amount}`;
  try {
    await sendMessage(OWNER_PHONE, msg);
    console.log("Daily report sent:", msg);
  } catch (err) {
    console.error("Failed to send daily report:", err.message);
  }
}
cron.schedule("0 21 * * *", sendDailyReport, { timezone: "Asia/Kolkata" });

// ─── WEBHOOK ────────────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) {
    res.status(200).send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;
    const phone = message.from;
    const msgType = message.type;
    let msgBody = "";
    if (msgType === "text") msgBody = message.text?.body?.trim();
    else if (msgType === "interactive") msgBody = message.interactive?.button_reply?.id || "";
    await handleMessage(phone, msgType, msgBody);
  } catch (err) {
    console.error("Error handling message:", err.message);
  }
});

app.get("/test-report", async (req, res) => {
  await sendDailyReport();
  res.send("Report sent (check owner's WhatsApp)");
});

app.get("/", (req, res) => res.send("PrintEasy WhatsApp Bot is running! 🖨️"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
