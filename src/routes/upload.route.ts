import { Router, Request, Response } from 'express';
import { z, ZodError } from 'zod';
import { storageService } from '../services/storage.service';

const router = Router();

const fileItemSchema = z.object({
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().positive(),
});

// The calling app is identified by its x-api-key (see apiKeyAuth), never by the request body.
function callerApp(req: Request) {
  if (!req.appName) {
    throw new Error('Request was not authenticated');
  }
  return req.appName;
}

// Validation errors from zod become a readable "path: message" list instead of a raw JSON dump.
function sendError(res: Response, error: unknown) {
  if (error instanceof ZodError) {
    const issues = error.issues.map((i) => ({ field: i.path.join('.') || 'body', message: i.message }));
    res.status(400).json({
      success: false,
      message: 'Invalid request: ' + issues.map((i) => i.field + ': ' + i.message).join('; '),
      issues,
    });
    return;
  }
  res.status(400).json({ success: false, message: error instanceof Error ? error.message : 'Unknown error' });
}

// ==========================================
// 1. NHÓM API TẠO PRESIGNED URL (1 FILE & NHIỀU FILE)
// ==========================================

// 1A. Presign 1 file
router.post('/presign', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      context: z.string().min(1),
      file: fileItemSchema,
    });
    const { context, file } = schema.parse(req.body);
    const data = await storageService.createPresignedPutUrl(callerApp(req), context, file);
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

// 1B. Presign nhiều file
router.post('/presign-batch', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      context: z.string().min(1),
      files: z.array(fileItemSchema).min(1),
    });
    const { context, files } = schema.parse(req.body);
    const data = await storageService.createPresignedPutBatch(callerApp(req), context, files);
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

// ==========================================
// 2. NHÓM API CONFIRM / COPY TỪ TEMP (1 FILE & NHIỀU FILE)
// ==========================================

// 2A. Confirm 1 file
router.post('/confirm', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      tempKey: z.string().min(1),
    });
    const { tempKey } = schema.parse(req.body);
    const data = await storageService.confirmFile(callerApp(req), tempKey);
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

// 2B. Confirm nhiều file
router.post('/confirm-batch', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      tempKeys: z.array(z.string().min(1)).min(1),
    });
    const { tempKeys } = schema.parse(req.body);
    const data = await storageService.confirmBatch(callerApp(req), tempKeys);
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

// ==========================================
// 3. NHÓM API XÓA FILE (1 FILE & NHIỀU FILE)
// ==========================================

// 3A. Xóa 1 file
router.delete('/', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      key: z.string().min(1),
    });
    const { key } = schema.parse(req.body);
    const data = await storageService.deleteFiles(callerApp(req), [key]);
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

// 3B. Xóa nhiều file
router.post('/delete-batch', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      keys: z.array(z.string().min(1)).min(1).max(1000),
    });
    const { keys } = schema.parse(req.body);
    const data = await storageService.deleteFiles(callerApp(req), keys);
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

// ==========================================
// 4. API LẤY LINK ĐỌC FILE PRIVATE (DÀNH CHO CV)
// ==========================================

router.post('/read-url', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      key: z.string().min(1),
      downloadFileName: z.string().optional(),
    });
    const { key, downloadFileName } = schema.parse(req.body);
    const data = await storageService.getPresignedReadUrl(callerApp(req), key, downloadFileName);
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
