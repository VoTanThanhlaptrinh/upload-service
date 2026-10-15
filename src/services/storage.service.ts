import {
  S3Client,
  PutObjectCommand,
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';
import path from 'path';
import { env } from '../config/env';
import { AppName, getPolicy } from '../config/app-policies';

export interface FileRequestItem {
  fileName: string;
  mimeType: string;
  size: number;
}

/**
 * Object keys are literal in S3/R2, but a client may normalize "." / ".." segments in a URL
 * before sending it, which could point a prefix-checked key at another app's files.
 */
function assertSafeKey(key: string) {
  const hasDotSegment = key.split('/').some((segment) => segment === '.' || segment === '..');
  if (hasDotSegment || key.includes('\\') || key.includes('//') || /[\u0000-\u001f]/.test(key)) {
    throw new Error(`Invalid key "${key}"`);
  }
}

/**
 * Inline Content-Disposition with an ASCII fallback plus an RFC 5987 UTF-8 name, so names with
 * spaces or accents show correctly (percent-encoding inside filename="..." would show up literally).
 */
function contentDisposition(fileName: string) {
  const fallback = fileName.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

type Visibility = 'public' | 'private';

/** Reads the visibility embedded in a key: "public/..." / "private/..." or the same under "temp/". */
function visibilityOf(key: string): Visibility {
  const match = /^(?:temp\/)?(public|private)\//.exec(key);
  if (!match) {
    throw new Error(`Invalid key "${key}"`);
  }
  return match[1] as Visibility;
}

class StorageService {
  private s3: S3Client;

  constructor() {
    this.s3 = new S3Client({
      region: env.STORAGE_REGION,
      endpoint: env.STORAGE_ENDPOINT,
      credentials: {
        accessKeyId: env.STORAGE_ACCESS_KEY_ID,
        secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY,
      },
      // R2 does not support the SDK's default CRC32 checksums, which otherwise end up as
      // extra query params on presigned PUT URLs; only send them when an operation requires it.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  /** Private files live in their own bucket (no public access); everything else in the public one. */
  private bucketFor(visibility: Visibility): string {
    return visibility === 'private' ? env.STORAGE_PRIVATE_BUCKET_NAME : env.STORAGE_BUCKET_NAME;
  }

  /**
   * 1. Tạo Presigned PUT URL cho 1 file (luôn đưa vào temp/)
   */
  async createPresignedPutUrl(app: AppName, context: string, file: FileRequestItem) {
    const policy = getPolicy(app, context);

    // Validate định dạng file
    if (!policy.allowedMimeTypes.includes(file.mimeType)) {
      throw new Error(
        `File "${file.fileName}" has invalid MIME type (${file.mimeType}). Allowed: ${policy.allowedMimeTypes.join(', ')}`
      );
    }

    // Validate kích thước file
    if (file.size <= 0 || file.size > policy.maxSizeBytes) {
      throw new Error(
        `File "${file.fileName}" size (${file.size} bytes) exceeds limit (${policy.maxSizeBytes} bytes)`
      );
    }

    const ext = path.extname(file.fileName).toLowerCase() || '';
    const yearMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
    const uuid = crypto.randomUUID();

    // Cấu trúc lưu trong temp: temp/{visibility}/{app}/{context}/{YYYY-MM}/{uuid}.{ext}
    // Nhúng luôn visibility vào đường dẫn để lúc confirm chỉ cần cắt chữ "temp/" là xong
    const tempKey = `temp/${policy.visibility}/${app}/${context}/${yearMonth}/${uuid}${ext}`;

    const command = new PutObjectCommand({
      Bucket: this.bucketFor(policy.visibility),
      Key: tempKey,
      ContentType: file.mimeType,
      ContentLength: file.size, // Ép cứng dung lượng trên S3/R2
    });

    const expiresIn = 600; // 10 phút
    const uploadUrl = await getSignedUrl(this.s3, command, { expiresIn });

    return {
      originalName: file.fileName,
      tempKey,
      uploadUrl,
      expiresIn,
      // Public temp files can be shown right away (e.g. editor preview); they still need confirm to persist.
      previewUrl:
        policy.visibility === 'public' ? `${env.STORAGE_PUBLIC_URL.replace(/\/$/, '')}/${tempKey}` : null,
    };
  }

  /**
   * 2. Tạo Presigned PUT URL cho nhiều file cùng lúc
   */
  async createPresignedPutBatch(app: AppName, context: string, files: FileRequestItem[]) {
    const policy = getPolicy(app, context);
    if (files.length > policy.maxFilesPerBatch) {
      throw new Error(
        `Batch size (${files.length}) exceeds max allowed (${policy.maxFilesPerBatch}) for ${app}/${context}`
      );
    }

    return Promise.all(files.map((file) => this.createPresignedPutUrl(app, context, file)));
  }

  /**
   * 3. Confirm (Copy) 1 file từ temp/ sang thư mục chính thức (public/ hoặc private/)
   */
  async confirmFile(app: AppName, tempKey: string) {
    assertSafeKey(tempKey);
    // Kiểm tra quyền sở hữu: tempKey bắt buộc phải thuộc về app đang gọi
    const expectedPrefixRegex = new RegExp(`^temp/(public|private)/${app}/`);
    if (!expectedPrefixRegex.test(tempKey)) {
      throw new Error(`Access denied: Key "${tempKey}" does not belong to app "${app}" or is not a temp key`);
    }

    // Bỏ chữ "temp/" ở đầu để ra key chính thức: public/{app}/... hoặc private/{app}/...
    const permanentKey = tempKey.replace(/^temp\//, '');
    const isPublic = visibilityOf(permanentKey) === 'public';
    // Temp and permanent copies share a visibility, hence a bucket, so this is a same-bucket copy.
    const bucket = this.bucketFor(isPublic ? 'public' : 'private');

    // Copy nội bộ trên Cloud Storage
    await this.s3.send(
      new CopyObjectCommand({
        Bucket: bucket,
        CopySource: `${bucket}/${encodeURIComponent(tempKey)}`,
        Key: permanentKey,
      })
    );

    // Không xóa file tạm ở đây: để Lifecycle Rule của R2 tự dọn thư mục temp/

    return {
      key: permanentKey,
      visibility: isPublic ? 'public' : 'private',
      url: isPublic ? `${env.STORAGE_PUBLIC_URL.replace(/\/$/, '')}/${permanentKey}` : null,
    };
  }

  /**
   * 4. Confirm (Copy) nhiều file cùng lúc
   */
  async confirmBatch(app: AppName, tempKeys: string[]) {
    return Promise.all(tempKeys.map((tempKey) => this.confirmFile(app, tempKey)));
  }

  /**
   * 5. Xóa 1 hoặc nhiều file (Có kiểm tra chống xóa chéo giữa các App)
   */
  async deleteFiles(app: AppName, keys: string[]) {
    const uniqueKeys = [...new Set(keys)];
    if (uniqueKeys.length === 0) return { deletedCount: 0, keys: [] as string[] };

    // Chặn tuyệt đối việc Blog xóa nhầm file của CellPhoneS hay Job Portal
    const validAppPrefix = new RegExp(`^(public|private|temp/(public|private))/${app}/`);
    for (const key of uniqueKeys) {
      assertSafeKey(key);
      if (!validAppPrefix.test(key)) {
        throw new Error(`Access denied: App "${app}" cannot delete file "${key}"`);
      }
    }

    // Public and private keys live in different buckets, so delete each group in its own call.
    const byVisibility: Record<Visibility, string[]> = { public: [], private: [] };
    for (const key of uniqueKeys) {
      byVisibility[visibilityOf(key)].push(key);
    }

    const results = await Promise.all(
      (Object.keys(byVisibility) as Visibility[])
        .filter((visibility) => byVisibility[visibility].length > 0)
        .map((visibility) =>
          this.s3.send(
            new DeleteObjectsCommand({
              Bucket: this.bucketFor(visibility),
              Delete: {
                Objects: byVisibility[visibility].map((Key) => ({ Key })),
                Quiet: true,
              },
            })
          )
        )
    );

    // Quiet mode only reports failures. S3/R2 deletes are idempotent, so a key that did not
    // exist is still counted as deleted; only keys the storage refused are excluded.
    const failed = results
      .flatMap((result) => result.Errors ?? [])
      .map((e) => ({ key: e.Key as string, code: e.Code, message: e.Message }));
    const failedKeys = new Set(failed.map((f) => f.key));
    const deletedKeys = uniqueKeys.filter((key) => !failedKeys.has(key));

    return {
      deletedCount: deletedKeys.length,
      keys: deletedKeys,
      ...(failed.length > 0 && { failed }),
    };
  }

  /**
   * 6. Tạo Presigned GET URL để đọc/tải file Private (ví dụ: xem CV trên Job Portal)
   */
  async getPresignedReadUrl(app: AppName, key: string, downloadFileName?: string) {
    assertSafeKey(key);
    const validAppPrefix = new RegExp(`^(private|public)/${app}/`);
    if (!validAppPrefix.test(key)) {
      throw new Error(`Access denied: Key "${key}" does not belong to app "${app}"`);
    }

    const command = new GetObjectCommand({
      Bucket: this.bucketFor(visibilityOf(key)),
      Key: key,
      ...(downloadFileName && {
        ResponseContentDisposition: contentDisposition(downloadFileName),
      }),
    });

    const expiresIn = 900; // 15 phút
    const readUrl = await getSignedUrl(this.s3, command, { expiresIn });

    return { key, readUrl, expiresIn };
  }
}

export const storageService = new StorageService();