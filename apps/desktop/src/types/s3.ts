export interface S3Bucket {
  name: string;
  creationDate?: string | null;
}

export interface S3Prefix {
  prefix: string;
}

export interface S3ObjectSummary {
  key: string;
  size: number;
  lastModified?: string | null;
  etag?: string | null;
}

export interface S3ListObjectsResponse {
  objects: S3ObjectSummary[];
  prefixes: S3Prefix[];
  isTruncated: boolean;
  nextContinuationToken?: string | null;
}

export interface S3ObjectHead {
  key: string;
  size: number;
  contentType?: string | null;
  etag?: string | null;
  lastModified?: string | null;
}

export interface S3ObjectPreview {
  key: string;
  size: number;
  contentType?: string | null;
  etag?: string | null;
  previewEncoding: "text" | "base64" | string;
  previewText?: string | null;
  previewBase64?: string | null;
  truncated: boolean;
}
