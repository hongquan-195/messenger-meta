const express = require("express");
const crypto = require("crypto");

const app = express();
app.use(express.json());

// =========================
// CẤU HÌNH
// =========================
const VERIFY_TOKEN = "fbs_verify_2026";

// Mỗi page -> dataset -> access token riêng
const PAGE_CONFIG = {
  "916541818208252": {
    name: "Cao Kim Thắm",
    datasetId: "437137782172073",
    accessToken: "EAAUiA2mi5PoBQxBKxxWXuQfn3pbsDD38ZCqESudYoh2XIeEaG0aeND78b3HRYabeZAS3nENDgEwWNipeFXcSYdURe0UYLh32u4FNNyQoyYfjZCGwk97dvGGIpqJrNLzi7B8AIPazqXTzYaIEhYxTV557MkGxZCtcFiPwqNvdedHZA743eWAHXFgF2v8LatQZDZD",
  },
  "100473475119497": {
    name: "Tâm Lý NHC",
    datasetId: "878492095227131",
    accessToken: "EAAUiA2mi5PoBQ2IESwPi6Jmj8FLpokHoXinE4VKG0J1M1ZCgAZBIfxfyTOomI3Rkpuv62pU26eq1JfW4sQOYxKhZBXfsFRC56IB39VGjFxLOrpJkiZBbFY3wetfSi9FvcyCWpObetUvm0pfdQ7TYna6X66AcVvaVw32BjOb1ruDGJ5U1YXzGX2YtAVPMkgZDZD",
  },
  "115119253675803": {
    name: "Bùi Thị Hải Yến",
    datasetId: "1168329245219850",
    accessToken: "EAAUiA2mi5PoBQxs7bwfZBI4U0UqBbHbUQGJDWpR7HB0qViCW4yPw0RyBteVQTm9k4NHoEoE7DR0VrMyFnnrZA6uvhbOzfnsUbzM1jxBdSnKrOcbmv76BnK5BwdMGTuF2ZCVTLygBun09Kf4pjE7juurQwHyfyo5kgWKErg7bDUCpUMrorHpU56QgIAcNQZDZD",
  },
};

// Phải có ít nhất 2 tin nhắn text trước khi tin nhắn chứa SĐT được tính lead
const MIN_MESSAGES_BEFORE_PHONE = 2;

// =========================
// BỘ NHỚ TẠM
// =========================
// key: `${pageId}_${psid}`
const conversationState = new Map();

// key: `${pageId}_${psid}_${phone}`
const sentLeadKeys = new Set();

// =========================
// HÀM HỖ TRỢ
// =========================
function getConversationKey(pageId, psid) {
  return `${pageId}_${psid}`;
}

function getLeadDedupKey(pageId, psid, phone) {
  return `${pageId}_${psid}_${phone}`;
}

function normalizeVNPhone(input) {
  if (!input) return null;

  const digits = input.replace(/\D/g, "");

  // 0xxxxxxxxx -> 84xxxxxxxxx
  if (digits.startsWith("0") && digits.length === 10) {
    return "84" + digits.slice(1);
  }

  // 84xxxxxxxxx
  if (digits.startsWith("84") && digits.length === 11) {
    return digits;
  }

  return null;
}

function extractVNPhone(text) {
  if (!text) return null;

  const matches = text.match(/(\+84|84|0)([\s.\-]?\d){8,10}/g);
  if (!matches) return null;

  for (const raw of matches) {
    const normalized = normalizeVNPhone(raw);
    if (normalized) return normalized;
  }

  return null;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function sendLeadSubmittedEvent({
  datasetId,
  accessToken,
  pageId,
  psid,
  phone,
  pageName,
}) {
  const eventId = `leadsubmitted_${pageId}_${psid}_${Date.now()}`;

  const payload = {
    data: [
      {
        event_name: "LeadSubmitted",
        event_time: Math.floor(Date.now() / 1000),
        action_source: "business_messaging",
        messaging_channel: "messenger",
        event_id: eventId,
        user_data: {
          page_id: pageId,
          page_scoped_user_id: psid,
          ph: sha256(phone),
        },
        custom_data: {
          page_name: pageName,
          lead_stage: "phone_captured_after_conversation",
          phone_country: "VN",
          min_messages_before_phone: MIN_MESSAGES_BEFORE_PHONE,
        },
      },
    ],
  };

  const url = `https://graph.facebook.com/v25.0/${datasetId}/events?access_token=${encodeURIComponent(
    accessToken
  )}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const resultText = await response.text();

  if (!response.ok) {
    throw new Error(`CAPI error ${response.status}: ${resultText}`);
  }

  console.log(`[CAPI SUCCESS] dataset=${datasetId} response=${resultText}`);
}

// =========================
// XÁC MINH WEBHOOK
// =========================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token) {
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("WEBHOOK_VERIFIED");
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  }

  return res.sendStatus(400);
});

// =========================
// NHẬN SỰ KIỆN MESSENGER
// =========================
app.post("/webhook", async (req, res) => {
  const body = req.body;

  // Trả 200 sớm để Meta không timeout
  res.status(200).send("EVENT_RECEIVED");

  if (body.object !== "page") {
    return;
  }

  try {
    for (const entry of body.entry || []) {
      const pageId = entry.id;
      const pageConfig = PAGE_CONFIG[pageId];

      if (!pageConfig) {
        console.log(`[SKIP] Page ${pageId} chưa được cấu hình.`);
        continue;
      }

      for (const event of entry.messaging || []) {
        if (!event.sender?.id) continue;
        if (!event.message?.text) continue;
        if (event.message?.is_echo) continue;

        const psid = event.sender.id;
        const text = event.message.text.trim();
        const convoKey = getConversationKey(pageId, psid);

        const oldState = conversationState.get(convoKey) || {
          messageCount: 0,
          leadSent: false,
        };

        const phone = extractVNPhone(text);

        // Chưa có SĐT -> chỉ đếm tin nhắn text
        if (!phone) {
          oldState.messageCount += 1;
          conversationState.set(convoKey, oldState);

          console.log(
            `[CHAT] page=${pageConfig.name} (${pageId}) psid=${psid} count=${oldState.messageCount} text="${text}"`
          );
          continue;
        }

        console.log(
          `[PHONE DETECTED] page=${pageConfig.name} (${pageId}) psid=${psid} phone=${phone} previousTextMessages=${oldState.messageCount}`
        );

        if (oldState.messageCount < MIN_MESSAGES_BEFORE_PHONE) {
          console.log(
            `[SKIP] Chưa đủ điều kiện lead. Mới có ${oldState.messageCount} tin nhắn trước đó, cần tối thiểu ${MIN_MESSAGES_BEFORE_PHONE}.`
          );
          continue;
        }

        const dedupKey = getLeadDedupKey(pageId, psid, phone);

        if (sentLeadKeys.has(dedupKey) || oldState.leadSent) {
          console.log("[SKIP] Lead đã gửi trước đó, bỏ qua trùng lặp.");
          continue;
        }

        await sendLeadSubmittedEvent({
          datasetId: pageConfig.datasetId,
          accessToken: pageConfig.accessToken,
          pageId,
          psid,
          phone,
          pageName: pageConfig.name,
        });

        oldState.leadSent = true;
        conversationState.set(convoKey, oldState);
        sentLeadKeys.add(dedupKey);

        console.log(
          `[LEAD SUBMITTED] page=${pageConfig.name}, dataset=${pageConfig.datasetId}`
        );
      }
    }
  } catch (error) {
    console.error("[WEBHOOK ERROR]", error.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

