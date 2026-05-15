import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
    hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-site' },
  })
);

app.use(express.json({ limit: '20kb' }));

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
      ? { rejectUnauthorized: false }
      : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contact_messages (
      id          SERIAL PRIMARY KEY,
      name        VARCHAR(120) NOT NULL,
      email       VARCHAR(160) NOT NULL,
      message     TEXT         NOT NULL,
      ip          VARCHAR(64),
      user_agent  TEXT,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS contact_messages_created_at_idx ON contact_messages (created_at DESC)'
  );
}

const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post('/api/contact', contactLimiter, async (req, res) => {
  const { name, email, message, consent, website } = req.body ?? {};

  // Honeypot — bots fill this hidden field
  if (typeof website === 'string' && website.trim() !== '') return res.status(204).end();

  if (typeof name !== 'string' || !name.trim() || name.length > 120)
    return res.status(400).json({ error: 'name' });
  if (typeof email !== 'string' || !EMAIL_RE.test(email) || email.length > 160)
    return res.status(400).json({ error: 'email' });
  if (typeof message !== 'string' || !message.trim() || message.length > 3000)
    return res.status(400).json({ error: 'message' });
  if (consent !== true) return res.status(400).json({ error: 'consent' });

  const ip = (req.headers['x-forwarded-for']?.toString().split(',')[0].trim()) || req.ip || '';
  const ua = (req.headers['user-agent'] || '').toString().slice(0, 500);

  try {
    await pool.query(
      'INSERT INTO contact_messages (name, email, message, ip, user_agent) VALUES ($1, $2, $3, $4, $5)',
      [name.trim(), email.trim().toLowerCase(), message.trim(), ip, ua]
    );
  } catch (err) {
    console.error('DB insert failed:', err);
    return res.status(500).json({ error: 'server' });
  }

  // Optional: email notification via Resend. Only fires if env vars are set.
  if (process.env.RESEND_API_KEY && process.env.NOTIFY_EMAIL) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: process.env.RESEND_FROM || 'onboarding@resend.dev',
          to: process.env.NOTIFY_EMAIL,
          reply_to: email,
          subject: `Nuovo messaggio da ${name} — madebypaolo.it`,
          text: `Da: ${name} <${email}>\n\n${message}`,
        }),
      });
    } catch (err) {
      console.error('Email notification failed:', err);
    }
  }

  res.status(201).json({ ok: true });
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders(res, p) {
      if (p.endsWith('.html')) {
        res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
      } else if (/\.(svg|png|jpg|jpeg|webp|woff2?)$/i.test(p)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  })
);

app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => app.listen(PORT, () => console.log(`Listening on :${PORT}`)))
  .catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
