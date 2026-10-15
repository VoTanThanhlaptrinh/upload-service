import { timingSafeEqual } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import type { AppName } from '../config/app-policies.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by apiKeyAuth: the web that owns the x-api-key sent with this request. */
      appName?: AppName;
    }
  }
}

const APP_KEYS: Record<AppName, string> = {
  blog: env.API_KEY_BLOG,
  cellphones: env.API_KEY_CELLPHONES,
  'job-portal': env.API_KEY_JOB_PORTAL,
};

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** Resolves which app is calling from its x-api-key, so a web cannot act as another app. */
export function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  const clientKey = req.headers['x-api-key'];

  if (typeof clientKey === 'string') {
    for (const [appName, key] of Object.entries(APP_KEYS) as [AppName, string][]) {
      if (safeEqual(clientKey, key)) {
        req.appName = appName;
        next();
        return;
      }
    }
  }

  res.status(401).json({
    success: false,
    message: 'Unauthorized: Invalid or missing x-api-key header',
  });
}
