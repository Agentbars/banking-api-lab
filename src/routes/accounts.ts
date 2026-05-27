import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  closeAccount,
  createAccount,
  getAccount,
  listAccounts,
  patchAccount,
} from '../services/accounts.service.js';

const router = Router();

router.get('/accounts', requireAuth, async (req, res, next) => {
  try {
    res.json(await listAccounts(req.user!.id));
  } catch (e) {
    next(e);
  }
});

router.post('/accounts', requireAuth, async (req, res, next) => {
  try {
    res.status(201).json(await createAccount(req.user!.id, req.body));
  } catch (e) {
    next(e);
  }
});

router.get('/accounts/:id', requireAuth, async (req, res, next) => {
  try {
    res.json(await getAccount(req.user!.id, req.params.id!));
  } catch (e) {
    next(e);
  }
});

router.patch('/accounts/:id', requireAuth, async (req, res, next) => {
  try {
    res.json(await patchAccount(req.user!.id, req.params.id!, req.body));
  } catch (e) {
    next(e);
  }
});

router.delete('/accounts/:id', requireAuth, async (req, res, next) => {
  try {
    await closeAccount(req.user!.id, req.params.id!);
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

export default router;
