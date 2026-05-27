import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  createBatch,
  createTransfer,
  getTransfer,
  reverseTransfer,
} from '../services/transfers.service.js';

const router = Router();

router.post('/transfers', requireAuth, async (req, res, next) => {
  try {
    res.status(201).json(await createTransfer(req.user!.id, req.body));
  } catch (e) {
    next(e);
  }
});

router.post('/transfers/batch', requireAuth, async (req, res, next) => {
  try {
    res.status(200).json(await createBatch(req.user!.id, req.body));
  } catch (e) {
    next(e);
  }
});

router.get('/transfers/:id', requireAuth, async (req, res, next) => {
  try {
    res.json(await getTransfer(req.user!.id, req.params.id!));
  } catch (e) {
    next(e);
  }
});

router.post('/transfers/:id/reverse', requireAuth, async (req, res, next) => {
  try {
    res.json(await reverseTransfer(req.user!.id, req.params.id!));
  } catch (e) {
    next(e);
  }
});

export default router;
