import { Router } from 'express';
import chatRouter  from './chat';
import toolsRouter from './tools';
import adminRouter from './admin';

const router = Router();
router.use('/chat',  chatRouter);
router.use('/tools', toolsRouter);
router.use('/admin', adminRouter);
export default router;
