import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { config } from '../config.js';
import { Errors } from '../errors.js';

export interface ObjectStorage {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

function client(): S3Client {
  if (!config.OBJECT_STORAGE_ENDPOINT) {
    throw Errors.internal('Object storage is not configured', undefined, 'STORAGE_NOT_CONFIGURED');
  }
  const credentials = config.OBJECT_STORAGE_ACCESS_KEY && config.OBJECT_STORAGE_SECRET_KEY
    ? { accessKeyId: config.OBJECT_STORAGE_ACCESS_KEY, secretAccessKey: config.OBJECT_STORAGE_SECRET_KEY }
    : undefined;
  return new S3Client({
    endpoint: config.OBJECT_STORAGE_ENDPOINT,
    region: config.OBJECT_STORAGE_REGION,
    forcePathStyle: config.OBJECT_STORAGE_FORCE_PATH_STYLE,
    credentials,
  });
}

export const s3Storage: ObjectStorage = {
  async put(key, body, contentType) {
    await client().send(new PutObjectCommand({ Bucket: config.OBJECT_STORAGE_BUCKET, Key: key, Body: body, ContentType: contentType }));
  },
  async get(key) {
    const result = await client().send(new GetObjectCommand({ Bucket: config.OBJECT_STORAGE_BUCKET, Key: key }));
    if (!result.Body) throw Errors.notFound('OBJECT_NOT_FOUND', 'Stored document content not found');
    return result.Body.transformToByteArray();
  },
  async delete(key) {
    await client().send(new DeleteObjectCommand({ Bucket: config.OBJECT_STORAGE_BUCKET, Key: key }));
  },
  async exists(key) {
    try {
      await client().send(new HeadObjectCommand({ Bucket: config.OBJECT_STORAGE_BUCKET, Key: key }));
      return true;
    } catch (error: any) {
      if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound') return false;
      throw error;
    }
  },
};
