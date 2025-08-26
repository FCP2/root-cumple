import express from "express";
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@adiwajshing/baileys";
import pino from "pino";
import QRCode from "qrcode";
import dayjs from "dayjs";
import "dayjs/locale/es.js";

import { google } from "googleapis";

dayjs.locale("es");

// ========= ENV =========
const PORT = process.env.PORT || 10000;
const AUTH_DIR = process.env.AUTH_DIR || "/data/baileys";
const SHEET_KEY = (process.env.SHEET_KEY || "").trim();
const WORKSHEET_NAME = process.env.WORKSHEET_NAME || "Hoja 1";
const DEST_NUMBERS = (process.env.DEST_NUMBERS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const SEND_MODE = (process.env.SEND_MODE || "today").toLowerCase(); // today | until_today
const CREDS_JSON = process.env.GCP_CREDENTIALS_JSON;

if (!SHEET_KEY) console.warn("⚠️ Falta SHEET_KEY");
if (!CREDS_JSON) console.warn("⚠️ Falta GCP_CREDENTIALS_JSON");

// ========= App & estado =========
const app = express();
app.use(express.json());

let sock = null;
let lastQR = "";     // string del QR en texto
let connReady = false;

// ========= Google Sheets helpers =========
function getSheetsClient() {
  if (!CREDS_JSON) throw new Error("Falta GCP_CREDENTIALS_JSON");
  const info = JSON.parse(CREDS_JSON);
  const auth = new google.auth.JWT(
    info.client_email,
    null,
    info.private_key,
    ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"]
  );
  return google.sheets({ version: "v4", auth });
}

function colToA1(colIndex) {
  // 1->A, 2->B...
  let s = "";
  let n = colIndex;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function readRows() {
  const sheets = getSheetsClient();
  const range = `${WORKSHEET_NAME}!A1:Z10000`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_KEY,
    range
  });
  const values = res.data.values || [];
  if (values.length === 0) return { headers: [], rows: [] };

  const headers = values[0];
  const rows = values.slice(1);
  return { headers, rows };
}

async function updateCell(rowIndex1, colIndex1, value) {
  const sheets = getSheetsClient();
  const a1 = `${WORKSHEET_NAME}!${colToA1(colIndex1)}${rowIndex1}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_KEY,
    range: a1,
    valueInputOption: "RAW",
    requestBody: { values: [[value]] }
  });
}

// ========= Fechas =========
function parseDDMMYY(s) {
  if (!s) return null;
  const t = s.toString().trim();
  // Soporta dd/mm/yy o dd/mm/yyyy
  const [d, m, y] = t.split("/");
  if (!d || !m || !y) return null;
  const year = y.length === 2 ? (2000 + parseInt(y, 10)) : parseInt(y, 10);
  const date = dayjs(`${year}-${m}-${d}`, "YYYY-M-D", true);
  return date.isValid() ? date : null;
}

function todayMX() {
  return dayjs().tz ? dayjs().tz("America/Mexico_City") : dayjs();
}

// ========= Baileys (WhatsApp) =========
async function startWA() {
  const logger = pino({ level: "silent" }); // baja logs

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      lastQR = qr;
      connReady = false;
      console.log("QR recibido (escanea en /qr.png)");
    }

    if (connection === "open") {
      connReady = true;
      lastQR = "";
      console.log("✅ WhatsApp conectado");
    } else if (connection === "close") {
      const shouldReconnect =
        (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
      console.log("Conexión cerrada. Reintentar:", shouldReconnect);
      connReady = false;
      if (shouldReconnect) startWA().catch(console.error);
    }
  });
}

async function sendText(toNumber, message) {
  if (!sock || !connReady) throw new Error("WhatsApp no está listo (escanea QR).");
  // Asegura formato internacional (ej. 521XXXXXXXXXX@s.whatsapp.net)
  const jid = toNumber.includes("@s.whatsapp.net")
    ? toNumber
    : `${toNumber}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text: message });
}

// ========= Rutas =========
app.get("/", (req, res) => {
  if (connReady) {
    res.send("✅ Sesión lista. Endpoints: /status, /qr.png, /preview, /send_pending, /send_test");
  } else {
    res.setHeader("Refresh", "8");
    res.send(`
      <html>
        <head><meta charset="utf-8"></head>
        <body style="font-family: system-ui; padding: 24px;">
          <h2>Vincula tu WhatsApp (escanea el QR)</h2>
          <p>La página se actualiza cada 8s.</p>
          <img src="/qr.png" alt="QR" style="max-width: 360px; border: 1px solid #ccc"/>
          <p><a href="/status" target="_blank">/status</a></p>
        </body>
      </html>
    `);
  }
});

app.get("/qr.png", async (req, res) => {
  try {
    if (!lastQR) {
      // Si ya está conectado o aún no hay QR
      const empty = await QRCode.toBuffer("Sesión lista o QR no disponible");
      res.type("png").send(empty);
      return;
    }
    const png = await QRCode.toBuffer(lastQR, { margin: 1, width: 360 });
    res.type("png").send(png);
  } catch (e) {
    res.status(500).send("QR error");
  }
});

app.get("/status", async (req, res) => {
  res.json({
    connected: connReady,
    hasQR: !!lastQR,
    sheetKey: !!SHEET_KEY,
    worksheet: WORKSHEET_NAME,
    destNumbers: DEST_NUMBERS.length,
    sendMode: SEND_MODE
  });
});

app.get("/send_test", async (req, res) => {
  try {
    const to = (req.query.to || "").trim();
    const msg = (req.query.msg || "Prueba ✅").toString();
    if (!to) return res.status(400).json({ error: "Usa ?to=521XXXXXXXXXX&msg=Texto" });
    await sendText(to, msg);
    res.json({ to, msg, status: "sent" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/preview", async (req, res) => {
  try {
    const { headers, rows } = await readRows();
    if (headers.length === 0) return res.json({ to_send: [] });

    const hmap = Object.fromEntries(headers.map((h, i) => [h.trim().toLowerCase(), i]));
    const iNombre = hmap["nombre"];
    const iCargo = hmap["cargo"];
    const iFecha = hmap["fecha"] ?? hmap["fecha (dd/mm/yy)"] ?? hmap["fecha(dd/mm/yy)"];
    const iEnviado = hmap["enviado"];

    if ([iNombre, iCargo, iFecha, iEnviado].some(i => i === undefined)) {
      return res.status(400).json({ error: "Encabezados esperados: Nombre, Cargo, Fecha, Enviado" });
    }

    const today = dayjs();
    const pending = [];
    rows.forEach((row, idx) => {
      const r = idx + 2; // fila real (1-based)
      const nombre = (row[iNombre] || "").toString().trim();
      const cargo = (row[iCargo] || "").toString().trim();
      const fecha = parseDDMMYY(row[iFecha]);
      const enviado = ((row[iEnviado] || "") + "").trim().toLowerCase();

      if (!fecha || enviado === "sí") return;

      const cond = (SEND_MODE === "today")
        ? fecha.isSame(today, "day")
        : fecha.isBefore(today.add(1, "day"), "day"); // <= hoy

      if (cond) {
        pending.push({
          row: r,
          Nombre: nombre,
          Cargo: cargo,
          Fecha: fecha.format("DD/MM/YYYY")
        });
      }
    });

    res.json({ today: today.format("YYYY-MM-DD"), mode: SEND_MODE, to_send: pending });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.all("/send_pending", async (req, res) => {
  try {
    if (!DEST_NUMBERS.length) return res.status(400).json({ error: "Configura DEST_NUMBERS" });
    const { headers, rows } = await readRows();
    const hmap = Object.fromEntries(headers.map((h, i) => [h.trim().toLowerCase(), i]));
    const iNombre = hmap["nombre"];
    const iCargo = hmap["cargo"];
    const iFecha = hmap["fecha"] ?? hmap["fecha (dd/mm/yy)"] ?? hmap["fecha(dd/mm/yy)"];
    const iEnviado = hmap["enviado"];
    if ([iNombre, iCargo, iFecha, iEnviado].some(i => i === undefined)) {
      return res.status(400).json({ error: "Encabezados esperados: Nombre, Cargo, Fecha, Enviado" });
    }

    const today = dayjs();
    const sent = [];
    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx];
      const r = idx + 2;
      const nombre = (row[iNombre] || "").toString().trim();
      const cargo  = (row[iCargo]  || "").toString().trim();
      const fecha  = parseDDMMYY(row[iFecha]);
      const enviado = ((row[iEnviado] || "") + "").trim().toLowerCase();

      if (!fecha || enviado === "sí") continue;

      const cond = (SEND_MODE === "today")
        ? fecha.isSame(today, "day")
        : fecha.isBefore(today.add(1, "day"), "day"); // <= hoy
      if (!cond) continue;

      const msg = `🎉 *Recordatorio*\n- Nombre: ${nombre}\n- Cargo: ${cargo}\n- Fecha: ${fecha.format("DD/MM/YYYY")}`;
      // envía a todos los destinatarios
      for (const num of DEST_NUMBERS) {
        await sendText(num, msg);
        await new Promise(r => setTimeout(r, 600)); // pequeña pausa
      }
      // marca Enviado = "sí" (columna iEnviado -> index 0-based, en A1 es colIndex1 = iEnviado+1)
      await updateCell(r, iEnviado + 1, "sí");

      sent.push({ row: r, Nombre: nombre });
      await new Promise(r => setTimeout(r, 400));
    }

    res.json({ today: today.format("YYYY-MM-DD"), mode: SEND_MODE, sent, count: sent.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========= Arranque =========
app.listen(PORT, async () => {
  console.log("HTTP on 0.0.0.0:" + PORT);
  try {
    await startWA();
  } catch (e) {
    console.error("startWA error:", e);
  }
});