import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { env } from './config/env';
import { apiKeyAuth } from './middlewares/api-key.middleware';
import uploadRouter from './routes/upload.route';

const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'file-service', timestamp: new Date().toISOString() });
});
// Health check endpoint (để ping chống ngủ đông server, không cần API key)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'file-service', timestamp: new Date().toISOString() });
});

// Mọi route bên dưới đều yêu cầu header x-api-key
app.use('/api/v1/files', apiKeyAuth, uploadRouter);

// Unmatched routes and body-parser errors (e.g. malformed JSON) also answer in JSON.
app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Not found' });
});
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error('[file-service] Unhandled error:', err);
  res.status(status).json({
    success: false,
    message: status === 500 ? 'Internal server error' : err.type === 'entity.parse.failed' ? 'Invalid JSON body' : err.message,
  });
});

app.listen(Number(env.PORT), () => {
  console.log(`[file-service] Running at http://localhost:${env.PORT}`);
});