import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getStatement } from '../services/statements.service.js';

const router = Router();

router.get('/accounts/:id/statement', requireAuth, async (req, res, next) => {
  try {
    res.json(await getStatement(req.user!.id, req.params.id!, req.query));
  } catch (e) {
    next(e);
  }
});

export default router;
