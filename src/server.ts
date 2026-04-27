import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import generationsRouter from './routes/generations';
import webhookRouter from './routes/webhook';

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/generations', generationsRouter);
app.use('/webhook', webhookRouter);

const port = process.env.PORT ?? 3000;
app.listen(port, () => console.log(`PicWith backend running on port ${port}`));
