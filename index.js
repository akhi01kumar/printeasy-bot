const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const app = express();
app.use(express.json());

// ─── CONFIG (set these as environment variables on Render) ─────────────────
const VERIFY_TOKEN  = process.env.VERIFY_TOKEN  || "my_xerox_bot_token";
const WA_TOKEN       = process.env.WA_TOKEN       || "YOUR_WHATSAPP_TOKEN";
const PHONE_ID        = process.env.PHONE_ID        || "YOUR_PHONE_NUMBER_ID";
const OWNER_PHONE     = process.env.OWNER_PHONE     || "91XXXXXXXXXX"; // your personal number, no +
const UPSTASH_URL     = process.env.UPSTASH_URL     || ""; // e.g. https://xxxx.upstash.io
const UPSTASH_TOKEN   = process.env.UPSTASH_TOKEN   || "";
// ──────────────────────────────────────────────────────────────────────────

// ─── PRICE LIST — hidden from customers, used only for backend calculation ─
// Edit these numbers any time your rates change. Nothing here is ever shown
// to the customer in chat.
const RATES = {
  bwPerPage: 3,              // B&W, single side or back-to-back — same rate
  colorPlain: {              // Color print on plain paper — tiered by total pages
    tier1: { max: 10, rate: 10 },   // up to 10 pages
    tier2: { max: 30, rate: 7 },    // 11–30 pages
    tier3: { max: Infinity, rate: 6 } // more than 30 pages
  },
  colorGlossyPerPage: 30,
  spiralBinding: 50,         // flat, up to 60 pages
  hardBinding: 230,          // flat, with golden embossing
  laminationCard: 20,        // per card
  laminationA4: 30           // per A4 sheet
};

function colorPlainRate(totalPrints) {
  if (totalPrints <= RATES.colorPlain.tier1.max) return RATES.colorPlain.tier1.rate;
  if (totalPrints <= RATES.colorPlain.tier2.max) return RATES.colorPlain.tier2.rate;
  return RATES.colorPlain.tier3.rate;
}

function calculatePrice(data) {
  const pages = parseInt(data.pages) || 1;
  const copies = parseInt(data.copies) || 1;
  const totalPrints = pages * copies; // total physical sheets printed

  let printCost = 0;
  if (data.printType === "bw") {
    printCost = totalPrints * RATES.bwPerPage;
  } else if (data.printType === "color_plain") {
    printCost = totalPrints * colorPlainRate(totalPrints);
  } else if (data.printType === "color_glossy") {
    printCost = totalPrints * RATES.colorGlossyPerPage;
  }

  let bindingCost = 0;
  if (data.binding === "spiral") bindingCost = RATES.spiralBinding;
  else if (data.binding === "hard") bindingCost = RATES.hardBinding;

  let laminationCost = 0;
  const lamQty = parseInt(data.laminationQty) || 0;
  if (data.lamination === "card") laminationCost = lamQty * RATES.laminationCard;
  else if (data.lamination === "a4") laminationCost = lamQty * RATES.laminationA4;

  const total = printCost + bindingCost + laminationCost;
  return { totalPrints, printCost, bindingCost, laminationCost, total };
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

// ─── In-memory session store  { phone: { step, data } } ────────────────────
const sessions = {};

function getSession(phone) {
  if (!sessions[phone]) {
    sessions[phone] = { step: "WELCOME", data: {} };
  }
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

// Order summary shown to CUSTOMER — no prices, ever.
function buildCustomerSummary(data) {
  const printLabel =
    data.printType === "bw"
      ? `Black & White (${data.bwSide === "back2back" ? "Back-to-Back" : "Single Side"})`
      : data.printType === "color_glossy"
      ? "Color — Glossy Paper"
      : "Color — Plain Paper";

  return (
    `📋 *ORDER SUMMARY*\n` +
    `─────────────────────\n` +
    `📄 File: ${data.file || "Sent via WhatsApp"}\n` +
    `📃 Pages: ${data.pages}\n` +
    `🔢 Copies: ${data.copies}\n` +
    `🎨 Print: ${printLabel}\n` +
    `📚 Binding: ${data.binding === "spiral" ? "Spiral Binding" : data.binding === "hard" ? "Hard Binding" : "None"}\n` +
    `✨ Lamination: ${data.lamination === "none" || !data.lamination ? "None" : `${data.lamination === "card" ? "Card" : "A4"} x${data.laminationQty}`}\n` +
    `⚡ Urgency: ${data.urgency}\n` +
    `🚚 Delivery: ${data.delivery}\n` +
    (data.address ? `📍 Address: ${data.address}\n` : "") +
    `💳 Payment: ${data.payment}\n` +
    `─────────────────────\n` +
    `Thank you! We'll confirm your order shortly. 🙏`
  );
}

async function handleMessage(phone, msgType, msgBody) {
  const session = getSession(phone);
  const { step, data } = session;

  if (step === "WELCOME") {
    await sendMessage(phone, `👋 Welcome to *PrintEasy Xerox & Print Services!*\n\nLet's get your order started.`);
    await sendMessage(phone, `📎 *Step 1* — Please send the *file* you want printed (PDF, Word, image, etc.)`);
    session.step = "ASK_FILE";
    return;
  }

  if (step === "ASK_FILE") {
    if (msgType === "document" || msgType === "image") {
      data.file = `File received (${msgType})`;
      await sendMessage(phone, `✅ File received!\n\n📃 *Step 2* — How many *pages* is the document?\nJust type a number.`);
      session.step = "ASK_PAGES";
    } else {
      await sendMessage(phone, `Please send the file as a document or image. 📎`);
    }
    return;
  }

  if (step === "ASK_PAGES") {
    const num = parseInt(msgBody);
    if (!isNaN(num) && num > 0) {
      data.pages = num;
      await sendMessage(phone, `🔢 *Step 3* — How many *copies* (sets) do you need?\nJust type a number.`);
      session.step = "ASK_COPIES";
    } else {
      await sendMessage(phone, `Please enter a valid number of pages (e.g. 5)`);
    }
    return;
  }

  if (step === "ASK_COPIES") {
    const num = parseInt(msgBody);
    if (!isNaN(num) && num > 0) {
      data.copies = num;
      await sendButtons(phone, `🎨 *Step 4* — Print type?`, [
        { id: "print_bw", title: "⬛ Black & White" },
        { id: "print_color", title: "🌈 Color" },
      ]);
      session.step = "ASK_PRINT_TYPE";
    } else {
      await sendMessage(phone, `Please enter a valid number of copies (e.g. 2)`);
    }
    return;
  }

  if (step === "ASK_PRINT_TYPE") {
    if (msgBody === "print_bw") {
      await sendButtons(phone, `Single side or back-to-back?`, [
        { id: "bw_single", title: "Single Side" },
        { id: "bw_back2back", title: "Back-to-Back" },
      ]);
      session.step = "ASK_BW_SIDE";
    } else if (msgBody === "print_color") {
      await sendButtons(phone, `Plain paper or glossy paper?`, [
        { id: "color_plain", title: "Plain Paper" },
        { id: "color_glossy", title: "✨ Glossy Paper" },
      ]);
      session.step = "ASK_COLOR_PAPER";
    } else {
      await sendButtons(phone, `Please choose print type:`, [
        { id: "print_bw", title: "⬛ Black & White" },
        { id: "print_color", title: "🌈 Color" },
      ]);
    }
    return;
  }

  if (step === "ASK_BW_SIDE") {
    if (msgBody === "bw_single" || msgBody === "bw_back2back") {
      data.printType = "bw";
      data.bwSide = msgBody === "bw_back2back" ? "back2back" : "single";
      await goToBinding(phone, session);
    } else {
      await sendButtons(phone, `Please choose:`, [
        { id: "bw_single", title: "Single Side" },
        { id: "bw_back2back", title: "Back-to-Back" },
      ]);
    }
    return;
  }

  if (step === "ASK_COLOR_PAPER") {
    if (msgBody === "color_plain" || msgBody === "color_glossy") {
      data.printType = msgBody;
      await goToBinding(phone, session);
    } else {
      await sendButtons(phone, `Please choose:`, [
        { id: "color_plain", title: "Plain Paper" },
        { id: "color_glossy", title: "✨ Glossy Paper" },
      ]);
    }
    return;
  }

  if (step === "ASK_BINDING") {
    const bindMap = { bind_none: "none", bind_spiral: "spiral", bind_hard: "hard" };
    if (bindMap[msgBody]) {
      data.binding = bindMap[msgBody];
      await sendButtons(phone, `✨ *Next* — Need lamination?`, [
        { id: "lam_none", title: "None" },
        { id: "lam_card", title: "Card" },
        { id: "lam_a4", title: "A4 Size" },
      ]);
      session.step = "ASK_LAMINATION";
    } else {
      await sendButtons(phone, `Please choose binding:`, [
        { id: "bind_none", title: "None" },
        { id: "bind_spiral", title: "📎 Spiral Binding" },
        { id: "bind_hard", title: "📕 Hard Binding" },
      ]);
    }
    return;
  }

  if (step === "ASK_LAMINATION") {
    const lamMap = { lam_none: "none", lam_card: "card", lam_a4: "a4" };
    if (lamMap[msgBody]) {
      data.lamination = lamMap[msgBody];
      if (data.lamination === "none") {
        await askUrgency(phone, session);
      } else {
        await sendMessage(phone, `How many items would you like to laminate? Type a number.`);
        session.step = "ASK_LAMINATION_QTY";
      }
    } else {
      await sendButtons(phone, `Please choose lamination:`, [
        { id: "lam_none", title: "None" },
        { id: "lam_card", title: "Card" },
        { id: "lam_a4", title: "A4 Size" },
      ]);
    }
    return;
  }

  if (step === "ASK_LAMINATION_QTY") {
    const num = parseInt(msgBody);
    if (!isNaN(num) && num > 0) {
      data.laminationQty = num;
      await askUrgency(phone, session);
    } else {
      await sendMessage(phone, `Please enter a valid number (e.g. 3)`);
    }
    return;
  }

  if (step === "ASK_URGENCY") {
    const urgMap = { urg_normal: "Normal (1-2 days)", urg_same: "Same Day", urg_express: "Express (2 hrs)" };
    data.urgency = urgMap[msgBody] || null;
    if (!data.urgency) {
      await sendButtons(phone, `How urgent is this order?`, [
        { id: "urg_normal", title: "Normal (1-2 days)" },
        { id: "urg_same", title: "⚡ Same Day" },
        { id: "urg_express", title: "🚀 Express (2 hrs)" },
      ]);
      return;
    }
    await sendButtons(phone, `🚚 Pickup or home delivery?`, [
      { id: "del_pickup", title: "🏪 Pick Up" },
      { id: "del_delivery", title: "🚚 Home Delivery" },
    ]);
    session.step = "ASK_DELIVERY";
    return;
  }

  if (step === "ASK_DELIVERY") {
    if (msgBody === "del_pickup") {
      data.delivery = "Shop Pickup";
      await askPayment(phone, session);
    } else if (msgBody === "del_delivery") {
      data.delivery = "Home Delivery";
      await sendMessage(phone, `📍 Please type your *full delivery address*:`);
      session.step = "ASK_ADDRESS";
    } else {
      await sendButtons(phone, `Please choose:`, [
        { id: "del_pickup", title: "🏪 Pick Up" },
        { id: "del_delivery", title: "🚚 Home Delivery" },
      ]);
    }
    return;
  }

  if (step === "ASK_ADDRESS") {
    data.address = msgBody;
    await askPayment(phone, session);
    return;
  }

  if (step === "ASK_PAYMENT") {
    const payMap = { pay_cash: "Cash", pay_upi: "UPI / GPay", pay_card: "Card" };
    if (!payMap[msgBody]) {
      await sendButtons(phone, `Please choose payment method:`, [
        { id: "pay_cash", title: "💵 Cash" },
        { id: "pay_upi", title: "📱 UPI / GPay" },
        { id: "pay_card", title: "💳 Card" },
      ]);
      return;
    }
    data.payment = payMap[msgBody];
    await sendMessage(phone, buildCustomerSummary(data));
    await sendButtons(phone, `Does this look correct?`, [
      { id: "confirm_yes", title: "✅ Yes, confirm!" },
      { id: "confirm_no", title: "❌ Start over" },
    ]);
    session.step = "CONFIRM";
    return;
  }

  if (step === "CONFIRM") {
    if (msgBody === "confirm_yes") {
      const priced = calculatePrice(data); // backend only — never shown to customer
      await recordOrderStats(priced.totalPrints, priced.total);

      await sendMessage(phone, `🎉 *Order Confirmed!*\n\nWe've received your order and will process it shortly. Thank you for choosing us! 🙏`);

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

async function goToBinding(phone, session) {
  await sendButtons(phone, `📚 *Next* — Need binding?`, [
    { id: "bind_none", title: "None" },
    { id: "bind_spiral", title: "📎 Spiral Binding" },
    { id: "bind_hard", title: "📕 Hard Binding" },
  ]);
  session.step = "ASK_BINDING";
}

async function askUrgency(phone, session) {
  await sendButtons(phone, `⚡ How urgent is this order?`, [
    { id: "urg_normal", title: "Normal (1-2 days)" },
    { id: "urg_same", title: "⚡ Same Day" },
    { id: "urg_express", title: "🚀 Express (2 hrs)" },
  ]);
  session.step = "ASK_URGENCY";
}

async function askPayment(phone, session) {
  await sendButtons(phone, `💳 How would you like to pay?`, [
    { id: "pay_cash", title: "💵 Cash" },
    { id: "pay_upi", title: "📱 UPI / GPay" },
    { id: "pay_card", title: "💳 Card" },
  ]);
  session.step = "ASK_PAYMENT";
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

// ─── WEBHOOK VERIFICATION ─────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) {
    res.status(200).send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(403);
  }
});

// ─── INCOMING MESSAGES ────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];
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

// Manual trigger for testing the report without waiting for 9 PM
app.get("/test-report", async (req, res) => {
  await sendDailyReport();
  res.send("Report sent (check owner's WhatsApp)");
});

app.get("/", (req, res) => res.send("PrintEasy WhatsApp Bot is running! 🖨️"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
