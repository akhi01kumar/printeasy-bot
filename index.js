const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

// ─── CONFIG (fill these in after Meta setup) ───────────────────────────────
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "my_xerox_bot_token";
const WA_TOKEN    = process.env.WA_TOKEN    || "YOUR_WHATSAPP_TOKEN";
const PHONE_ID    = process.env.PHONE_ID    || "YOUR_PHONE_NUMBER_ID";
const OWNER_PHONE = process.env.OWNER_PHONE || "91XXXXXXXXXX"; // your number with country code, no +
// ──────────────────────────────────────────────────────────────────────────

// In-memory session store  { phone: { step, data } }
const sessions = {};

// ─── CONVERSATION FLOW ────────────────────────────────────────────────────
const STEPS = [
  "WELCOME",
  "ASK_FILE",
  "ASK_COPIES",
  "ASK_COLOR",
  "ASK_SIZE",
  "ASK_BINDING",
  "ASK_URGENCY",
  "ASK_DELIVERY",
  "ASK_ADDRESS",   // only if delivery = yes
  "ASK_PAYMENT",
  "CONFIRM",
  "DONE",
];

function getSession(phone) {
  if (!sessions[phone]) {
    sessions[phone] = { step: "WELCOME", data: {} };
  }
  return sessions[phone];
}

async function sendMessage(to, text) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${PHONE_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    },
    { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
  );
}

async function sendButtons(to, body, buttons) {
  // buttons: [{id, title}]
  await axios.post(
    `https://graph.facebook.com/v19.0/${PHONE_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body },
        action: {
          buttons: buttons.map((b) => ({
            type: "reply",
            reply: { id: b.id, title: b.title },
          })),
        },
      },
    },
    { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
  );
}

function buildOrderSummary(data) {
  return (
    `📋 *ORDER SUMMARY*\n` +
    `─────────────────────\n` +
    `📄 File: ${data.file || "Sent via WhatsApp"}\n` +
    `🔢 Copies: ${data.copies}\n` +
    `🎨 Print type: ${data.color}\n` +
    `📐 Paper size: ${data.size}\n` +
    `📚 Binding/Lamination: ${data.binding}\n` +
    `⚡ Urgency: ${data.urgency}\n` +
    `🚚 Delivery: ${data.delivery}\n` +
    (data.address ? `📍 Address: ${data.address}\n` : "") +
    `💳 Payment: ${data.payment}\n` +
    `─────────────────────\n` +
    `Thank you! We'll confirm your order shortly. 🙏`
  );
}

async function handleMessage(phone, msgType, msgBody, msgMedia) {
  const session = getSession(phone);
  const { step, data } = session;

  // ── WELCOME ──
  if (step === "WELCOME") {
    await sendMessage(
      phone,
      `👋 Welcome to *PrintEasy Xerox & Print Services!*\n\nI'll help you place your print order in just a few steps.\n\nLet's get started! 🖨️`
    );
    await sendMessage(phone, `📎 *Step 1/9* — Please send me the *file* you want to print (PDF, Word, image, etc.)`);
    session.step = "ASK_FILE";
    return;
  }

  // ── ASK_FILE ──
  if (step === "ASK_FILE") {
    if (msgType === "document" || msgType === "image") {
      data.file = `File received (${msgType})`;
      await sendMessage(phone, `✅ File received!\n\n🔢 *Step 2/9* — How many *copies* do you need?\n\nJust type a number (e.g. 5)`);
      session.step = "ASK_COPIES";
    } else {
      await sendMessage(phone, `Please send the file as a document or image. 📎`);
    }
    return;
  }

  // ── ASK_COPIES ──
  if (step === "ASK_COPIES") {
    const num = parseInt(msgBody);
    if (!isNaN(num) && num > 0) {
      data.copies = num;
      await sendButtons(phone, `🎨 *Step 3/9* — Should the print be in *Color or Black & White?*`, [
        { id: "color_bw", title: "⬛ Black & White" },
        { id: "color_color", title: "🌈 Color" },
      ]);
      session.step = "ASK_COLOR";
    } else {
      await sendMessage(phone, `Please enter a valid number of copies (e.g. 2)`);
    }
    return;
  }

  // ── ASK_COLOR ──
  if (step === "ASK_COLOR") {
    if (msgBody === "color_bw" || msgBody?.toLowerCase().includes("black")) {
      data.color = "Black & White";
    } else if (msgBody === "color_color" || msgBody?.toLowerCase().includes("color")) {
      data.color = "Color";
    } else {
      await sendButtons(phone, `Please choose print type:`, [
        { id: "color_bw", title: "⬛ Black & White" },
        { id: "color_color", title: "🌈 Color" },
      ]);
      return;
    }
    await sendButtons(phone, `📐 *Step 4/9* — What *paper size* do you need?`, [
      { id: "size_a4", title: "A4" },
      { id: "size_a3", title: "A3" },
      { id: "size_letter", title: "Letter" },
    ]);
    session.step = "ASK_SIZE";
    return;
  }

  // ── ASK_SIZE ──
  if (step === "ASK_SIZE") {
    const sizeMap = { size_a4: "A4", size_a3: "A3", size_letter: "Letter" };
    if (sizeMap[msgBody]) {
      data.size = sizeMap[msgBody];
    } else if (["a4","a3","letter"].includes(msgBody?.toLowerCase())) {
      data.size = msgBody.toUpperCase();
    } else {
      await sendButtons(phone, `Please choose paper size:`, [
        { id: "size_a4", title: "A4" },
        { id: "size_a3", title: "A3" },
        { id: "size_letter", title: "Letter" },
      ]);
      return;
    }
    await sendButtons(phone, `📚 *Step 5/9* — Do you need *Binding or Lamination?*`, [
      { id: "bind_none", title: "None" },
      { id: "bind_spiral", title: "📎 Spiral Binding" },
      { id: "bind_laminate", title: "✨ Lamination" },
    ]);
    session.step = "ASK_BINDING";
    return;
  }

  // ── ASK_BINDING ──
  if (step === "ASK_BINDING") {
    const bindMap = { bind_none: "None", bind_spiral: "Spiral Binding", bind_laminate: "Lamination" };
    if (bindMap[msgBody]) {
      data.binding = bindMap[msgBody];
    } else {
      data.binding = msgBody || "None";
    }
    await sendButtons(phone, `⚡ *Step 6/9* — How *urgent* is your order?`, [
      { id: "urg_normal", title: "Normal (1-2 days)" },
      { id: "urg_same", title: "⚡ Same Day" },
      { id: "urg_express", title: "🚀 Express (2 hrs)" },
    ]);
    session.step = "ASK_URGENCY";
    return;
  }

  // ── ASK_URGENCY ──
  if (step === "ASK_URGENCY") {
    const urgMap = { urg_normal: "Normal (1-2 days)", urg_same: "Same Day", urg_express: "Express (2 hrs)" };
    data.urgency = urgMap[msgBody] || msgBody || "Normal";
    await sendButtons(phone, `🚚 *Step 7/9* — Do you want *home delivery* or will you *pick up* from our shop?`, [
      { id: "del_pickup", title: "🏪 Pick Up" },
      { id: "del_delivery", title: "🚚 Home Delivery" },
    ]);
    session.step = "ASK_DELIVERY";
    return;
  }

  // ── ASK_DELIVERY ──
  if (step === "ASK_DELIVERY") {
    if (msgBody === "del_pickup" || msgBody?.toLowerCase().includes("pick")) {
      data.delivery = "Shop Pickup";
      await sendButtons(phone, `💳 *Step 8/9* — How would you like to *pay?*`, [
        { id: "pay_cash", title: "💵 Cash" },
        { id: "pay_upi", title: "📱 UPI / GPay" },
        { id: "pay_card", title: "💳 Card" },
      ]);
      session.step = "ASK_PAYMENT";
    } else if (msgBody === "del_delivery" || msgBody?.toLowerCase().includes("delivery")) {
      data.delivery = "Home Delivery";
      await sendMessage(phone, `📍 *Step 8/9* — Please type your *full delivery address:*`);
      session.step = "ASK_ADDRESS";
    } else {
      await sendButtons(phone, `Please choose delivery option:`, [
        { id: "del_pickup", title: "🏪 Pick Up" },
        { id: "del_delivery", title: "🚚 Home Delivery" },
      ]);
    }
    return;
  }

  // ── ASK_ADDRESS ──
  if (step === "ASK_ADDRESS") {
    data.address = msgBody;
    await sendButtons(phone, `💳 *Step 9/9* — How would you like to *pay?*`, [
      { id: "pay_cash", title: "💵 Cash" },
      { id: "pay_upi", title: "📱 UPI / GPay" },
      { id: "pay_card", title: "💳 Card" },
    ]);
    session.step = "ASK_PAYMENT";
    return;
  }

  // ── ASK_PAYMENT ──
  if (step === "ASK_PAYMENT") {
    const payMap = { pay_cash: "Cash", pay_upi: "UPI / GPay", pay_card: "Card" };
    data.payment = payMap[msgBody] || msgBody || "Cash";

    const summary = buildOrderSummary(data);
    await sendMessage(phone, summary);
    await sendButtons(phone, `Does everything look correct?`, [
      { id: "confirm_yes", title: "✅ Yes, confirm!" },
      { id: "confirm_no", title: "❌ Start over" },
    ]);
    session.step = "CONFIRM";
    return;
  }

  // ── CONFIRM ──
  if (step === "CONFIRM") {
    if (msgBody === "confirm_yes" || msgBody?.toLowerCase() === "yes") {
      await sendMessage(phone, `🎉 *Order Confirmed!*\n\nWe've received your order and will process it shortly.\n\nFor any queries, feel free to message us here. Thank you for choosing us! 🙏`);

      // Notify shop owner
      const ownerMsg =
        `🔔 *NEW PRINT ORDER!*\n` +
        `─────────────────────\n` +
        `📞 Customer: +${phone}\n` +
        buildOrderSummary(data);
      await sendMessage(OWNER_PHONE, ownerMsg);

      session.step = "DONE";
      session.data = {};
    } else {
      // Reset
      sessions[phone] = { step: "WELCOME", data: {} };
      await handleMessage(phone, "text", "start", null);
    }
    return;
  }

  // ── DONE / fallback ──
  if (step === "DONE") {
    sessions[phone] = { step: "WELCOME", data: {} };
    await handleMessage(phone, "text", "start", null);
  }
}

// ─── WEBHOOK VERIFICATION ─────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === VERIFY_TOKEN
  ) {
    res.status(200).send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(403);
  }
});

// ─── INCOMING MESSAGES ────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // always ack immediately

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) return;

    const phone = message.from;
    const msgType = message.type;

    let msgBody = "";
    let msgMedia = null;

    if (msgType === "text") {
      msgBody = message.text?.body?.trim();
    } else if (msgType === "interactive") {
      msgBody = message.interactive?.button_reply?.id || "";
    } else if (msgType === "document" || msgType === "image") {
      msgMedia = message[msgType];
    }

    await handleMessage(phone, msgType, msgBody, msgMedia);
  } catch (err) {
    console.error("Error handling message:", err.message);
  }
});

app.get("/", (req, res) => res.send("PrintEasy WhatsApp Bot is running! 🖨️"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
