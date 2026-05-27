import express from 'express';
import { errorHandler } from './middleware/errorHandler.js';
import authRouter from './routes/auth.js';
import accountsRouter from './routes/accounts.js';
import transactionsRouter from './routes/transactions.js';
import transfersRouter from './routes/transfers.js';
import statementsRouter from './routes/statements.js';

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.use(authRouter);
  app.use(accountsRouter);
  app.use(transactionsRouter);
  app.use(transfersRouter);
  app.use(statementsRouter);
  app.use(errorHandler);
  return app;
}
