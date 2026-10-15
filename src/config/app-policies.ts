export type AppName = 'blog' | 'cellphones' | 'job-portal';

export interface ContextPolicy {
  visibility: 'public' | 'private';
  allowedMimeTypes: string[];
  maxSizeBytes: number;
  maxFilesPerBatch: number;
}

const MB = 1024 * 1024;

export const APP_POLICIES: Record<AppName, Record<string, ContextPolicy>> = {
  blog: {
    'post-image': {
      visibility: 'public',
      allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
      maxSizeBytes: 5 * MB,
      maxFilesPerBatch: 10,
    },
    avatar: {
      visibility: 'public',
      allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
      maxSizeBytes: 2 * MB,
      maxFilesPerBatch: 1,
    },
  },
  cellphones: {
    'product-gallery': {
      visibility: 'public',
      allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
      maxSizeBytes: 2 * MB,
      maxFilesPerBatch: 8,
    },
  },
  'job-portal': {
    'company-logo': {
      visibility: 'public',
      allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
      maxSizeBytes: 2 * MB,
      maxFilesPerBatch: 1,
    },
    'candidate-cv': {
      visibility: 'private', // File ẩn, chỉ đọc qua Presigned GET URL
      allowedMimeTypes: [
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ],
      maxSizeBytes: 10 * MB,
      maxFilesPerBatch: 1,
    },
  },
};

// Hàm lấy policy và kiểm tra hợp lệ
export function getPolicy(app: AppName, context: string): ContextPolicy {
  const appConfig = APP_POLICIES[app];
  if (!appConfig) {
    throw new Error(`Invalid app: ${app}`);
  }
  const policy = appConfig[context];
  if (!policy) {
    throw new Error(`Invalid context "${context}" for app "${app}"`);
  }
  return policy;
}