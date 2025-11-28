const axios = require("axios");

// Objeto para trackear los tiempos por chat
const cooldownMap = new Map();

const handler = async (msg, { conn, args }) => {
  const chatId = msg.key.remoteJid;
  const text = args.join(" ");

  // Verificar cooldown (3 minutos = 180000 ms)
  const now = Date.now();
  const lastUsed = cooldownMap.get(chatId);
  const cooldownTime = 180000; // 3 minutos en milisegundos

  if (lastUsed && (now - lastUsed) < cooldownTime) {
    const timeLeft = Math.ceil((cooldownTime - (now - lastUsed)) / 1000);
    const minutesLeft = Math.floor(timeLeft / 60);
    const secondsLeft = timeLeft % 60;

    return conn.sendMessage(chatId, {
      text: `⏰ *Espera un poco!*\n\nEl comando pinterest tiene un cooldown de 3 minutos.\nTiempo restante: *${minutesLeft}:${secondsLeft.toString().padStart(2, '0')}*`
    }, { quoted: msg });
  }

  if (!text) {
    return conn.sendMessage(chatId, {
      text: "✳️ Uso: *.pinterest <texto>*\n\nEjemplo: *.pinterest bmw*"
    }, { quoted: msg });
  }

  try {
    // Actualizar el cooldown
    cooldownMap.set(chatId, now);

    const res = await axios.get(`https://api.dorratz.com/v2/pinterest?q=${encodeURIComponent(text)}`);

    if (!Array.isArray(res.data) || res.data.length === 0) {
      return conn.sendMessage(chatId, {
        text: "⚠️ No se encontraron imágenes para esa búsqueda."
      }, { quoted: msg });
    }

    // seleccionar hasta 1p imágenes random
    const shuffled = res.data.sort(() => 0.10 - Math.random());
    const selected = shuffled.slice(0, 10);

    for (const [i, img] of selected.entries()) {
      await conn.sendMessage(chatId, {
        image: { url: img.image_large_url },
        caption: `🔎 Pinterest: *${text}*\nResultado ${i + 1}/${selected.length}\nAPI by dorratz.com`
      }, { quoted: msg });
    }

  } catch (e) {
    console.error("❌ Error en .pinterest:", e);
    await conn.sendMessage(chatId, {
      text: "❌ Error al buscar en Pinterest."
    }, { quoted: msg });
  }
};

handler.command = ["pinterest", "pin"];
module.exports = handler;