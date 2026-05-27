import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { loginUser, registerUser } from '../services/auth.service.js';

const router = Router();

router.post('/auth/register', async (req, res, next) => {
  try {
    res.status(201).json(await registerUser(req.body));
  } catch (e) {
    next(e);
  }
});

router.post('/auth/login', async (req, res, next) => {
  try {
    res.status(200).json(await loginUser(req.body));
  } catch (e) {
    next(e);
  }
});

router.get('/me', requireAuth, (req, res) => {
  const u = req.user!;
  res.json({
    id: u.id,
    email: u.email,
    name: u.name,
    createdAt: u.createdAt.toISOString(),
  });
});

export default router;
