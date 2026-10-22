import "server-only";

import { AwsClient } from "aws4fetch";

// Private file storage on Cloudflare R2, through its S3-compatible API.
// Browsers upload and download directly with short-lived presigned URLs, so
// files never pass through our servers (Vercel caps request bodies at about
// 4.5 MB). The keys below stay on the server; only signed URLs leave it.

export const STORAGE_ENV_VARS = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
] as const;

const UPLOAD_URL_TTL_SECONDS = 60 * 60;
const DOWNLOAD_URL_TTL_SECONDS = 15 * 60;

export const DOWNLOAD_URL_TTL_MS = DOWNLOAD_URL_TTL_SECONDS * 1000;

export const isStorageConfigured = STORAGE_ENV_VARS.every((name) => Boolean(process.env[name]));

// What the manual library needs from storage, so tests can swap in a fake.
export type FileStorage = {
  uploadUrl(key: string): Promise<string>;
  downloadUrl(key: string, fileName: string): Promise<string>;
  // The object's size in bytes, or null when there's no such object.
  size(key: string): Promise<number | null>;
};

let client: AwsClient | undefined;

function bucketUrl() {
  // R2_ENDPOINT points at a stand-in server for local testing.
  const endpoint =
    process.env.R2_ENDPOINT?.replace(/\/+$/, "") ||
    `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  return `${endpoint}/${encodeURIComponent(process.env.R2_BUCKET ?? "")}`;
}

function objectUrl(key: string) {
  return new URL(`${bucketUrl()}/${key.split("/").map(encodeURIComponent).join("/")}`);
}

function getClient() {
  if (!isStorageConfigured) {
    throw new Error(`File storage isn't configured. Set ${STORAGE_ENV_VARS.join(", ")}.`);
  }
  client ??= new AwsClient({
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    service: "s3",
    region: "auto",
    retries: 2,
  });
  return client;
}

async function presign(url: URL, method: string, expiresIn: number, headers?: Record<string, string>) {
  url.searchParams.set("X-Amz-Expires", String(expiresIn));
  const signed = await getClient().sign(url.toString(), {
    method,
    headers,
    // allHeaders puts Content-Type in the signature, so the upload has to
    // be sent as a PDF.
    aws: { signQuery: true, allHeaders: true },
  });
  return signed.url;
}

// A plain ASCII file name for the browser's download prompt and tab title.
function dispositionFor(fileName: string) {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export const r2Storage: FileStorage = {
  uploadUrl(key) {
    return presign(objectUrl(key), "PUT", UPLOAD_URL_TTL_SECONDS, { "content-type": "application/pdf" });
  },

  downloadUrl(key, fileName) {
    const url = objectUrl(key);
    url.searchParams.set("response-content-disposition", dispositionFor(fileName));
    return presign(url, "GET", DOWNLOAD_URL_TTL_SECONDS);
  },

  async size(key) {
    const response = await getClient().fetch(objectUrl(key).toString(), { method: "HEAD" });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Storage HEAD failed with ${response.status}`);
    const length = Number(response.headers.get("content-length"));
    return Number.isFinite(length) ? length : null;
  },
};
