const fs = require("fs");
const path = require("path");
const { Boom } = require("@hapi/boom");
const pino = require("pino");
const QRCode = require("qrcode");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
} = require("@whiskeysockets/baileys");

const { subBots, socketEvents, reconnectionAttempts } = require("../indexsubbots");

const MAX_SUBBOTS = 200;

const handler = async (msg, { conn, command, sock, args }) => {
  const usarPairingCode = ["sercode", "code"].includes(command);
  let sentCodeMessage = false;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Función para verificar si un número existe en WhatsApp
  async function verifyWhatsAppNumber(number) {
    try {
      const formattedNumber = number.replace(/[^0-9]/g, '');
      const jid = `${formattedNumber}@s.whatsapp.net`;

      // Intentar obtener la foto de perfil (si existe, el número es válido)
      await conn.profilePictureUrl(jid, 'image');
      return { exists: true, jid };
    } catch (error) {
      if (error.status === 404) {
        return { exists: false, jid: null };
      }
      // Otros errores pueden significar que existe pero no tiene foto
      return { exists: true, jid: `${number.replace(/[^0-9]/g, '')}@s.whatsapp.net` };
    }
  }

  // Función para validar formato de número
  function isValidPhoneNumber(number) {
    const cleanNumber = number.replace(/[^0-9]/g, '');
    return cleanNumber.length >= 10 && cleanNumber.length <= 15;
  }

  async function serbot() {
    let targetNumber = args[0];

    // Si no se proporcionó número, pedirlo
    if (!targetNumber) {
      return await conn.sendMessage(
        msg.key.remoteJid,
        {
          text: `📱 *CONEXIÓN DE SUB-BOT*\n\nPor favor proporciona un número de WhatsApp:\n\n*Ejemplos:*\n${global.prefix}${command} 5491123456789\n${global.prefix}${command} +54 9 11 2345-6789\n\n💡 *Formato:* Código país + número (sin espacios especiales)\n\n> Serbot by: *ghostdev.js*`
        },
        { quoted: msg }
      );
    }

    // Validar formato del número
    if (!isValidPhoneNumber(targetNumber)) {
      return await conn.sendMessage(
        msg.key.remoteJid,
        {
          text: "❌ *Número inválido*\n\nEl formato debe ser:\n• 5491123456789\n• +5491123456789\n• 541123456789\n\n📱 Mínimo 10 dígitos, máximo 15."
        },
        { quoted: msg }
      );
    }

    // Verificar si el número existe en WhatsApp
    await conn.sendMessage(msg.key.remoteJid, { 
      react: { text: "🔍", key: msg.key } 
    });

    const verification = await verifyWhatsAppNumber(targetNumber);

    if (!verification.exists) {
      return await conn.sendMessage(
        msg.key.remoteJid,
        {
          text: `❌ *Número no encontrado*\n\nEl número *${targetNumber}* no está registrado en WhatsApp.\n\n💡 Verifica:\n• El código de país\n• Que el número esté correcto\n• Que tenga WhatsApp activo`
        },
        { quoted: msg }
      );
    }

    // Número verificado, continuar con la conexión
    const number = verification.jid;
    const sessionDir = path.join(__dirname, "../subbots");
    const sessionPath = path.join(sessionDir, number);
    const rid = number.split("@")[0];

    try {
      if (subBots.includes(sessionPath)) {
        return await conn.sendMessage(
          msg.key.remoteJid,
          {
            text: `ℹ️ *Sub-bot ya existe*\n\nEl número *${targetNumber}* ya tiene una sesión activa.\n\n🧹 Usa *${global.prefix}delbots* para eliminar la sesión actual.\n🔁 Luego usa *${global.prefix}${command} ${targetNumber}* para crear una nueva.`
          },
          { quoted: msg },
        );
      }

      subBots.push(sessionPath);

      /* ───────── VERIFICACIÓN DE LÍMITE ───────── */
      if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
      }

      const subbotDirs = fs
        .readdirSync(sessionDir)
        .filter((d) => fs.existsSync(path.join(sessionDir, d, "creds.json")));

      if (subbotDirs.length >= MAX_SUBBOTS) {
        await conn.sendMessage(
          msg.key.remoteJid,
          {
            text: `🚫 *Límite alcanzado*\n\nExisten ${subbotDirs.length}/${MAX_SUBBOTS} sesiones activas.\n\n💡 Espera a que alguien elimine su sesión o contacta al administrador.`
          },
          { quoted: msg },
        );
        return;
      }

      const restantes = MAX_SUBBOTS - subbotDirs.length;
      await conn.sendMessage(
        msg.key.remoteJid,
        {
          text: `✅ *Número verificado:* ${targetNumber}\n📊 *Espacios disponibles:* ${restantes}/${MAX_SUBBOTS}\n\n> Enviando código…`
        },
        { quoted: msg },
      );

      await conn.sendMessage(msg.key.remoteJid, { react: { text: "⌛", key: msg.key } });

      let socky;
      async function createSocket() {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();
        const logger = pino({ level: "silent" });

        socky = makeWASocket({
          version,
          logger,
          auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
          },
          printQRInTerminal: !usarPairingCode,
          browser: ["Windows", "Chrome"],
          syncFullHistory: false,
        });

        return { socky, saveCreds };
      }

      let readyBot = false;
      let connectionTimeout;

      async function setupSocketEvents() {
        const { socky, saveCreds } = await createSocket();

        connectionTimeout = setTimeout(async () => {
          if (!readyBot) {
            await conn.sendMessage(
              msg.key.remoteJid,
              {
                text: `⏰ *Tiempo agotado*\n\nNo se escaneó el código para el número *${targetNumber}*.\n\n💡 Vuelve a intentarlo con:\n${global.prefix}${command} ${targetNumber}`
              },
              { quoted: msg },
            );

            const index = subBots.indexOf(sessionPath);
            if (index !== -1) subBots.splice(index, 1);

            socky.end(new Error("Timeout"));
            if (fs.existsSync(sessionPath)) {
              fs.rmSync(sessionPath, { recursive: true, force: true });
            }
          }
        }, 120_000);

        socky.ev.on("connection.update", async ({ qr, connection, lastDisconnect }) => {
          if (qr && !sentCodeMessage) {
            if (usarPairingCode) {
              const code = await socky.requestPairingCode(rid);
              await conn.sendMessage(
                msg.key.remoteJid,
                {
                  video: { url: "https://cdn.russellxz.click/b0cbbbd3.mp4" },
                  caption: `🔐 *CÓDIGO PARA: ${targetNumber}*\n\nAbre WhatsApp en el dispositivo de *${targetNumber}* y ve a:\nWhatsApp → Ajustes → Dispositivos vinculados → Vincular un dispositivo\n\n📋 *Código:*`
                },
                { quoted: msg },
              );
              await sleep(1000);
              await conn.sendMessage(
                msg.key.remoteJid,
                { text: `\`\`\`${code}\`\`\`` },
                { quoted: msg },
              );
            } else {
              const qrImage = await QRCode.toBuffer(qr);
              await conn.sendMessage(
                msg.key.remoteJid,
                {
                  image: qrImage,
                  caption: `📲 *QR PARA: ${targetNumber}*\n\nEscanea este código desde WhatsApp → Ajustes → Dispositivos vinculados`
                },
                { quoted: msg },
              );
            }
            sentCodeMessage = true;
          }

          if (connection === "open") {
            readyBot = true;
            clearTimeout(connectionTimeout);
            reconnectionAttempts.set(sessionPath, 0);

            // Mensaje de éxito
            await conn.sendMessage(
              msg.key.remoteJid,
              {
                text: `🎉 *SUB-BOT CONECTADO EXITOSAMENTE*\n\n📱 *Número:* ${targetNumber}\n✅ *Estado:* Conectado y operativo\n🕒 *Hora:* ${new Date().toLocaleString()}\n\n💡 El sub-bot ahora está listo para usar. Revisa el chat privado del número ${targetNumber} para las instrucciones.\n\n> Serbot by: *ghostdev.js*`
              },
              { quoted: msg },
            );

            await conn.sendMessage(msg.key.remoteJid, { react: { text: "✅", key: msg.key } });

            // Enviar instrucciones al chat privado del sub-bot
            const ownerJid = `${socky.user.id.split(":")[0]}@s.whatsapp.net`;
            await socky.sendMessage(ownerJid, {
              text: `✨ ¡Hola! Bienvenido al sistema de SubBots Premium de M-ster Ultra Bot ✨
              
✅ *Estado:* Tu SubBot para el número ${targetNumber} está *en línea y conectado*.

📌 *CONFIGURACIÓN INICIAL:*

🔹 *Para usar en grupos:*
   Ve al grupo y escribe: \`.addgrupo\`

🔹 *Para autorizar usuarios en privado:*
   Responde un mensaje con: \`.addlista\`
   O usa: \`.addlista número\`

🔹 *Cambiar prefijo de comandos:*
   \`.setprefix ✨\`

🔹 *Ver comandos disponibles:*
   \`.menu\` o \`.help\`

🚀 ¡Disfruta de M-ster Ultra Bot!\n\n> SerBot by: *ghostdev.js*`
            }).catch(() => {
              console.log("No se pudo enviar mensaje de bienvenida al sub-bot");
            });

            await socketEvents(socky);
          }

          // ... (el resto del código de reconexión se mantiene igual)
          if (connection === "close") {
            clearTimeout(connectionTimeout);
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log(`❌ Subbot ${targetNumber} desconectado (status: ${statusCode}).`);

            const shouldReconnect =
              statusCode !== DisconnectReason.loggedOut &&
              statusCode !== DisconnectReason.badSession &&
              statusCode !== DisconnectReason.forbidden &&
              statusCode !== 403;

            if (shouldReconnect) {
              const attempts = (reconnectionAttempts.get(sessionPath) || 0) + 1;
              reconnectionAttempts.set(sessionPath, attempts);

              if (attempts <= 3) {
                console.log(`💱 Reconectando ${targetNumber} (Intento ${attempts}/3)`);
                if (!readyBot && statusCode !== DisconnectReason.restartRequired) {
                  await conn.sendMessage(
                    msg.key.remoteJid,
                    {
                      text: `⚠️ *Problema de conexión con ${targetNumber}*\nRazón: ${statusCode}\nIntentando reconectar...`
                    },
                    { quoted: msg },
                  );
                }
                const index = subBots.indexOf(sessionPath);
                if (index !== -1) subBots.splice(index, 1);

                setTimeout(() => {
                  if (fs.existsSync(sessionPath)) {
                    subBots.push(sessionPath);
                    setupSocketEvents().catch((e) => console.error("Error en reconexión:", e));
                  } else {
                    console.log(`ℹ️ Sesión de ${targetNumber} eliminada. Cancelando reconexión.`);
                    reconnectionAttempts.delete(sessionPath);
                  }
                }, 3000);
              } else {
                console.log(`❌ Límite de reconexión para ${targetNumber}. Eliminando sesión.`);
                await conn.sendMessage(
                  msg.key.remoteJid,
                  {
                    text: `⚠️ *Límite de reconexión alcanzado para ${targetNumber}*\nLa sesión ha sido eliminada.`
                  },
                  { quoted: msg },
                );

                const index = subBots.indexOf(sessionPath);
                if (index !== -1) subBots.splice(index, 1);

                if (fs.existsSync(sessionPath)) {
                  fs.rmSync(sessionPath, { recursive: true, force: true });
                }
                reconnectionAttempts.delete(sessionPath);
              }
            } else {
              console.log(`❌ No se puede reconectar ${targetNumber}.`);
              if (!readyBot) {
                await conn.sendMessage(
                  msg.key.remoteJid,
                  {
                    text: `⚠️ *Sesión eliminada para ${targetNumber}*\n${statusCode}`
                  },
                  { quoted: msg },
                );
              }
              const index = subBots.indexOf(sessionPath);
              if (index !== -1) subBots.splice(index, 1);
              if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
              }
            }
          }
        });

        socky.ev.on("creds.update", saveCreds);
      }

      await setupSocketEvents();
    } catch (e) {
      console.error("❌ Error en serbot:", e);

      const index = subBots.indexOf(sessionPath);
      if (index !== -1) {
        subBots.splice(index, 1);
      }
      await conn.sendMessage(
        msg.key.remoteJid,
        { text: `❌ *Error con ${targetNumber}:* ${e.message}` },
        { quoted: msg },
      );
    }
  }

  await serbot();
};

handler.command = ["sercode", "code", "jadibot", "serbot", "qr"];
handler.tags = ["owner"];
handler.help = ["serbot <número>", "code <número>"];
module.exports = handler;