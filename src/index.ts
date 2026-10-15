import express from 'express';
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

app.listen(Number(env.PORT), () => {
  console.log(`[file-service] Running at http://localhost:${env.PORT}`);
});