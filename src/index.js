import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import morgan from 'morgan';
import cron from 'node-cron';
import { flywheelCycle, forceSync, getLastRun } from './pipeline.js';
import { getStats, initStats, getConfigPublic } from './stats.js';

const app = express();

app.use(helmet({ hidePoweredBy: true }));

const ALLOWED_ORIGINS = (process.env.FRONTEND_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (!ALLOWED_ORIGINS.length) return cb(null, true);
    cb(null, ALLOWED_ORIGINS.includes(origin));
  }
}));

app.use(express.json());
app.use(morgan('tiny'));

await initStats();

app.get('/public/stats', async (_req, res) => res.json(await getStats()));
app.get('/public/config', async (_req, res) => res.json(await getConfigPublic()));

const adminLimiter = rateLimit({ windowMs: 60_000, max: 10 });
function authOk(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return token && token === process.env.ADMIN_BEARER_TOKEN;
}

app.get('/admin/last-run', adminLimiter, (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
  res.json(getLastRun());
});

app.post('/admin/run-once', adminLimiter, async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
  try { const result = await flywheelCycle(); res.json({ ok: true, result }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

app.post('/admin/force-sync', adminLimiter, async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
  try { const out = await forceSync(); res.json({ ok: true, result: out }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 8787;
app.listen(port, () => console.log(`[flywheel] listening :${port}`));

if (process.env.ENABLE_CRON !== 'false') {
  cron.schedule('*/20 * * * *', async () => { try { await flywheelCycle(); } catch (e) { console.error(e); } });
}
const testSeconds = parseInt(process.env.TEST_INTERVAL_SECONDS || '0');
if (testSeconds > 0 && testSeconds < 60) {
  setInterval(async () => { try { await flywheelCycle(); } catch (e) {} }, testSeconds * 1000);
}
