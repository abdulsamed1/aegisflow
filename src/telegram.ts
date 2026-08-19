/**
 * Telegram Notification Service
 * Sends operational alerts to single operator channel
 */

export async function sendTelegramNotification(
  botToken: string,
  chatId: string,
  messageText: string
): Promise<boolean> {
  if (!botToken || !chatId) {
    console.warn("Telegram botToken or chatId not configured. Skipping alert.");
    return false;
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: messageText,
        parse_mode: "Markdown"
      })
    });

    return res.ok;
  } catch (err) {
    console.error("Failed to send Telegram alert:", err);
    return false;
  }
}
