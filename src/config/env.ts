import dotenv from 'dotenv';
import path from 'path';
import { z } from 'zod';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const apiKey = (name: string) => z.string().min(32, `${name} must be at least 32 characters`);

const envSchema = z
  .object({
    PORT: z.string().default('4000'),
    API_KEY_BLOG: apiKey('API_KEY_BLOG'),
    API_KEY_CELLPHONES: apiKey('API_KEY_CELLPHONES'),
    API_KEY_JOB_PORTAL: apiKey('API_KEY_JOB_PORTAL'),
    STORAGE_REGION: z.string().default('auto'),
    STORAGE_ENDPOINT: z.string().url('STORAGE_ENDPOINT must be a valid URL, e.g. https://<account-id>.r2.cloudflarestorage.com'),
    STORAGE_ACCESS_KEY_ID: z.string().min(1),
    STORAGE_SECRET_ACCESS_KEY: z.string().min(1),
    STORAGE_BUCKET_NAME: z.string().min(1),
    STORAGE_PRIVATE_BUCKET_NAME: z.string().min(1),
    STORAGE_PUBLIC_URL: z.string().url('STORAGE_PUBLIC_URL must be a valid URL'),
  })
  .refine((e) => e.STORAGE_BUCKET_NAME !== e.STORAGE_PRIVATE_BUCKET_NAME, {
    message: 'STORAGE_PRIVATE_BUCKET_NAME must differ from STORAGE_BUCKET_NAME, otherwise private files become public',
    path: ['STORAGE_PRIVATE_BUCKET_NAME'],
  })
  .refine(
    (e) => new Set([e.API_KEY_BLOG, e.API_KEY_CELLPHONES, e.API_KEY_JOB_PORTAL]).size === 3,
    { message: 'API_KEY_BLOG, API_KEY_CELLPHONES and API_KEY_JOB_PORTAL must all be different', path: ['API_KEY_*'] },
  );

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  console.error(`[file-service] Invalid environment variables (check .env):\n${details}`);
  process.exit(1);
}

export const env = parsed.data;
