import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  deposit,
  listTransactions,
  withdraw,
} from '../services/transactions.service.js';

const router = Router();

router.get('/accounts/:id/transactions', requireAuth, async (req, res, next) => {
  try {
    res.json(await listTransactions(req.user!.id, req.params.id!, req.query));
  } catch (e) {
    next(e);
  }
});

router.post('/accounts/:id/deposit', requireAuth, async (req, res, next) => {
  try {
    res.status(201).json(await deposit(req.user!.id, req.params.id!, req.body));
  } catch (e) {
    next(e);
  }
});

router.post('/accounts/:id/withdraw', requireAuth, async (req, res, next) => {
  try {
    res.status(201).json(await withdraw(req.user!.id, req.params.id!, req.body));
  } catch (e) {
    next(e);
  }
});

export default router;
