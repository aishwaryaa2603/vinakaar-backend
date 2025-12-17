
const recentEmailRequests = new Set();

// backend/server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const sgMail = require('@sendgrid/mail');
const Airtable = require('airtable');

const app = express();

// Config
const PORT = process.env.PORT || 3000;
const CSV_PATH = path.join(__dirname, 'requests.csv');
const PDF_REL_PATH = process.env.PDF_FILENAME || 'Vinakaar Manifestation Journal.pdf'; // place file in backend/assets/
const PDF_PATH = path.join(__dirname, 'assets', PDF_REL_PATH);

// SendGrid setup
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'abc@gmail.com';
if (!SENDGRID_API_KEY) {
  console.warn('WARNING: SENDGRID_API_KEY not set. Emails will fail until you set it in .env');
} else {
  sgMail.setApiKey(SENDGRID_API_KEY);
}
if (!FROM_EMAIL || FROM_EMAIL === 'abc@gmail.com') {
  console.warn('WARNING: FROM_EMAIL is not set or left as default. Make sure this is a verified sender in SendGrid.');
}

// Airtable config check (not fatal)
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || 'Requests';
if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
  console.warn('WARNING: Airtable is not fully configured. Set AIRTABLE_API_KEY and AIRTABLE_BASE_ID in .env to enable saving requests to Airtable.');
}

// Middlewares
app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: false }));
// For dev: allow all origins. In production tighten this to your frontend origin(s).
app.use(cors());

// Health
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Helper: append CSV row
function appendCsvRow({ name, email, phone }) {
  const header = 'timestamp,name,email,phone\n';
  const timestamp = new Date().toISOString();
  const esc = (v) => {
    if (v == null) return '';
    return `"${String(v).replace(/"/g, '""')}"`;
  };
  const row = `${esc(timestamp)},${esc(name)},${esc(email)},${esc(phone)}\n`;
  try {
    if (!fs.existsSync(CSV_PATH)) {
      fs.writeFileSync(CSV_PATH, header + row, { encoding: 'utf8' });
    } else {
      fs.appendFileSync(CSV_PATH, row, { encoding: 'utf8' });
    }
  } catch (err) {
    console.error('Failed to append CSV row', err);
  }
}

// Airtable helper: save a row (non-fatal — logs errors)
async function saveToAirtable({ name, email, phone, timestamp }) {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    // Airtable not configured; skip silently but log
    console.warn('Skipping Airtable save: API key or Base ID not configured.');
    return;
  }

  try {
    const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);
    const fields = {
      Name: name || '',
      Email: email || '',
      Phone: phone || '',
      Timestamp: timestamp || new Date().toISOString(),
    };

    // Airtable.create accepts an array of records
    await base(AIRTABLE_TABLE_NAME).create([{ fields }]);
    console.log(`Saved request to Airtable table "${AIRTABLE_TABLE_NAME}"`);
  } catch (err) {
    console.error('Airtable error while creating record:', err && err.message ? err.message : err);
    if (err && err.response && err.response.data) {
      console.error('Airtable response:', err.response.data);
    }
    // Do not throw — we don't want a failing Airtable to break email sending
  }
}

// simple email validation
function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * POST /api/send-pdf
 * Body: { name, email, phone }
 */
app.post('/api/send-pdf', async (req, res) => {
  try {
    const { name, email, phone } = req.body || {};
    // ===== Deduplication guard (prevents double email) =====
const dedupeKey = `${email}-${new Date().toISOString().slice(0, 16)}`; // per-minute key

if (recentEmailRequests.has(dedupeKey)) {
  console.log('Duplicate request blocked for:', email);
  return res.json({ ok: true, message: 'Already sent recently' });
}

recentEmailRequests.add(dedupeKey);

// auto-clean after 2 minutes
setTimeout(() => {
  recentEmailRequests.delete(dedupeKey);
}, 2 * 60 * 1000);

    if (!name || !email) {
      return res.status(400).json({ ok: false, error: 'name and email required' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ ok: false, error: 'invalid email' });
    }

    // Check PDF exists
    if (!fs.existsSync(PDF_PATH)) {
      console.error('PDF not found at', PDF_PATH);
      return res.status(500).json({ ok: false, error: 'PDF not available on server' });
    }

    // Log request locally (CSV)
    appendCsvRow({ name, email, phone });

    // ALSO save to Airtable (non-blocking for other steps)
    // We await to avoid racing tests, but it will not block email because it's run before SendGrid.
    const ts = new Date().toISOString();
    await saveToAirtable({ name, email, phone, timestamp: ts });

    // Read file and convert to base64 for SendGrid attachment
    const fileBuffer = fs.readFileSync(PDF_PATH);
    const fileBase64 = fileBuffer.toString('base64');

    // Compose message
    const msg = {
      to: email,
      from: FROM_EMAIL,
      subject: process.env.EMAIL_SUBJECT || 'Your requested PDF from Vinakaar',
      text:
        (process.env.EMAIL_TEXT ||
          `Hi ${name},\n\nThanks for requesting the PDF. Please find it attached.\n\nWarmly,\nVinakaar`) + '\n',
      attachments: [
        {
          content: fileBase64,
          filename: path.basename(PDF_PATH),
          type: 'application/pdf',
          disposition: 'attachment',
        },
      ],
    };

    // Send via SendGrid
    if (!SENDGRID_API_KEY) {
      console.error('No SENDGRID_API_KEY configured — cannot send email.');
      return res.status(500).json({ ok: false, error: 'email provider not configured' });
    }

    try {
      const response = await sgMail.send(msg);
      // SendGrid returns an array of responses; log status if present
      console.log(`PDF emailed to ${email}. SendGrid response status: ${response && response[0] && response[0].statusCode}`);
      return res.json({ ok: true, message: 'Email sent' });
    } catch (sendErr) {
      console.error('SendGrid error:', sendErr && sendErr.message ? sendErr.message : sendErr);
      if (sendErr && sendErr.response && sendErr.response.body) {
        console.error('SendGrid response body:', JSON.stringify(sendErr.response.body, null, 2));
      }
      // For dev: include message detail; in prod you may want to hide details
      return res.status(500).json({ ok: false, error: 'failed to send email', details: sendErr && sendErr.message });
    }
  } catch (err) {
    console.error('Error in /api/send-pdf', err);
    return res.status(500).json({ ok: false, error: 'server error' });
  }
});

// Serve assets (PDF) for debug
app.get('/assets/:file', (req, res) => {
  const file = req.params.file;
  const full = path.join(__dirname, 'assets', file);
  if (fs.existsSync(full)) {
    return res.sendFile(full);
  } else {
    return res.status(404).send('Not found');
  }
});

app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
  console.log(`POST endpoint for testing: http://localhost:${PORT}/api/send-pdf`);
  console.log(`Ensure your PDF exists at: ${PDF_PATH} (file exists: ${fs.existsSync(PDF_PATH)})`);
  console.log(`SendGrid API key present: ${!!SENDGRID_API_KEY}; FROM_EMAIL: ${FROM_EMAIL}`);
  console.log(`Airtable configured: ${!!AIRTABLE_API_KEY && !!AIRTABLE_BASE_ID}; Table: ${AIRTABLE_TABLE_NAME}`);
});
