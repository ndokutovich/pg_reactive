/**
 * pgStack Storage Client
 *
 * Supabase-compatible storage API for uploading, downloading, listing,
 * and deleting files stored in PostgreSQL bytea columns.
 *
 * Usage:
 *   const pgstack = createClient('http://127.0.0.1:8080', 'your-anon-key')
 *   const { data, error } = await pgstack.storage.from('avatars').upload('user/pic.png', file)
 */

export interface StorageError {
  message: string;
  status: number;
}

export interface StorageObject {
  id: string;
  name: string;
  size: number;
  mime_type: string;
  created_at: string;
}

export interface UploadResult {
  id: string;
  path: string;
}

type HeadersFn = () => Record<string, string>;

/**
 * Storage client that provides access to storage buckets.
 *
 * Obtained via `pgstackClient.storage`.
 */
export class StorageClient {
  private url: string;
  private headersFn: HeadersFn;

  constructor(url: string, headersFn: HeadersFn) {
    this.url = url;
    this.headersFn = headersFn;
  }

  /** Select a bucket to perform operations on. */
  from(bucket: string): StorageBucketApi {
    return new StorageBucketApi(this.url, bucket, this.headersFn);
  }

  /** Create a new storage bucket (requires service_role). */
  async createBucket(
    id: string,
    options?: {
      public?: boolean;
      fileSizeLimit?: number;
      allowedMimeTypes?: string[];
    },
  ): Promise<{ data: { name: string } | null; error: StorageError | null }> {
    try {
      const res = await fetch(`${this.url}/storage/v1/bucket`, {
        method: 'POST',
        headers: this.headersFn(),
        body: JSON.stringify({
          id,
          public: options?.public ?? false,
          file_size_limit: options?.fileSizeLimit,
          allowed_mime_types: options?.allowedMimeTypes,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return {
          data: null,
          error: {
            message: body.error || res.statusText,
            status: res.status,
          },
        };
      }

      const data = await res.json();
      return { data: { name: data.id }, error: null };
    } catch (e) {
      return {
        data: null,
        error: {
          message: e instanceof Error ? e.message : String(e),
          status: 0,
        },
      };
    }
  }

  /** List all storage buckets. */
  async listBuckets(): Promise<{
    data: Array<{
      id: string;
      public: boolean;
      file_size_limit: number;
      allowed_mime_types: string[];
      created_at: string;
    }> | null;
    error: StorageError | null;
  }> {
    try {
      const res = await fetch(`${this.url}/storage/v1/bucket`, {
        method: 'GET',
        headers: this.headersFn(),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return {
          data: null,
          error: {
            message: body.error || res.statusText,
            status: res.status,
          },
        };
      }

      const data = await res.json();
      return { data, error: null };
    } catch (e) {
      return {
        data: null,
        error: {
          message: e instanceof Error ? e.message : String(e),
          status: 0,
        },
      };
    }
  }

  /** Delete a storage bucket (requires service_role). */
  async deleteBucket(
    id: string,
  ): Promise<{ data: { message: string } | null; error: StorageError | null }> {
    try {
      const res = await fetch(
        `${this.url}/storage/v1/bucket/${encodeURIComponent(id)}`,
        {
          method: 'DELETE',
          headers: this.headersFn(),
        },
      );

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return {
          data: null,
          error: {
            message: body.error || res.statusText,
            status: res.status,
          },
        };
      }

      const data = await res.json();
      return { data, error: null };
    } catch (e) {
      return {
        data: null,
        error: {
          message: e instanceof Error ? e.message : String(e),
          status: 0,
        },
      };
    }
  }
}

/**
 * Provides operations on a specific storage bucket.
 */
export class StorageBucketApi {
  private url: string;
  private bucket: string;
  private headersFn: HeadersFn;

  constructor(url: string, bucket: string, headersFn: HeadersFn) {
    this.url = url;
    this.bucket = bucket;
    this.headersFn = headersFn;
  }

  /**
   * Upload a file to the bucket.
   *
   * @param path - The path within the bucket (e.g. "folder/image.png")
   * @param file - The file data as File, Blob, or ArrayBuffer
   * @param options - Optional upload options
   * @returns The uploaded object ID and path
   */
  async upload(
    path: string,
    file: File | Blob | ArrayBuffer,
    options?: { contentType?: string; upsert?: boolean },
  ): Promise<{ data: UploadResult | null; error: StorageError | null }> {
    try {
      const formData = new FormData();
      let blob: Blob;
      if (file instanceof ArrayBuffer) {
        blob = new Blob([file], {
          type: options?.contentType ?? 'application/octet-stream',
        });
      } else if (options?.contentType) {
        blob = new Blob([file], { type: options.contentType });
      } else {
        blob = file;
      }
      formData.append('file', blob);

      // Build headers without Content-Type (let the browser set multipart boundary)
      const headers = this.headersFn();
      delete headers['Content-Type'];

      const encodedPath = path
        .split('/')
        .map(encodeURIComponent)
        .join('/');

      const res = await fetch(
        `${this.url}/storage/v1/object/${encodeURIComponent(this.bucket)}/${encodedPath}`,
        {
          method: 'POST',
          headers,
          body: formData,
        },
      );

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return {
          data: null,
          error: {
            message: body.error || res.statusText,
            status: res.status,
          },
        };
      }

      const data = await res.json();
      return {
        data: { id: data.id, path: data.key },
        error: null,
      };
    } catch (e) {
      return {
        data: null,
        error: {
          message: e instanceof Error ? e.message : String(e),
          status: 0,
        },
      };
    }
  }

  /**
   * Download a file from the bucket.
   *
   * @param path - The path within the bucket
   * @returns The file data as a Blob
   */
  async download(
    path: string,
  ): Promise<{ data: Blob | null; error: StorageError | null }> {
    try {
      const headers = this.headersFn();
      // No Content-Type needed for GET
      delete headers['Content-Type'];

      const encodedPath = path
        .split('/')
        .map(encodeURIComponent)
        .join('/');

      const res = await fetch(
        `${this.url}/storage/v1/object/${encodeURIComponent(this.bucket)}/${encodedPath}`,
        {
          method: 'GET',
          headers,
        },
      );

      if (!res.ok) {
        // Try JSON error response first, fall back to status text
        const text = await res.text();
        let message = res.statusText;
        try {
          const body = JSON.parse(text);
          if (body.error) message = body.error;
        } catch {
          // not JSON, use status text
        }
        return {
          data: null,
          error: { message, status: res.status },
        };
      }

      const blob = await res.blob();
      return { data: blob, error: null };
    } catch (e) {
      return {
        data: null,
        error: {
          message: e instanceof Error ? e.message : String(e),
          status: 0,
        },
      };
    }
  }

  /**
   * List objects in the bucket.
   *
   * @param prefix - Optional path prefix to filter results
   * @returns Array of storage objects (without data)
   */
  async list(
    prefix?: string,
  ): Promise<{ data: StorageObject[] | null; error: StorageError | null }> {
    try {
      const params = prefix ? `?prefix=${encodeURIComponent(prefix)}` : '';
      const res = await fetch(
        `${this.url}/storage/v1/object/list/${encodeURIComponent(this.bucket)}${params}`,
        {
          method: 'GET',
          headers: this.headersFn(),
        },
      );

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return {
          data: null,
          error: {
            message: body.error || res.statusText,
            status: res.status,
          },
        };
      }

      const data = await res.json();
      return { data, error: null };
    } catch (e) {
      return {
        data: null,
        error: {
          message: e instanceof Error ? e.message : String(e),
          status: 0,
        },
      };
    }
  }

  /**
   * Remove one or more files from the bucket.
   *
   * @param paths - Array of file paths to delete
   */
  async remove(
    paths: string[],
  ): Promise<{ data: { path: string; message: string }[] | null; error: StorageError | null }> {
    const results: { path: string; message: string }[] = [];
    let firstError: StorageError | null = null;

    for (const path of paths) {
      const encodedPath = path.split('/').map(encodeURIComponent).join('/');
      try {
        const res = await fetch(
          `${this.url}/storage/v1/object/${encodeURIComponent(this.bucket)}/${encodedPath}`,
          {
            method: 'DELETE',
            headers: this.headersFn(),
          },
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const err: StorageError = { message: body.error || res.statusText, status: res.status };
          if (!firstError) firstError = err;
          continue;
        }
        results.push({ path, message: 'deleted' });
      } catch (err) {
        const e: StorageError = { message: err instanceof Error ? err.message : 'network error', status: 0 };
        if (!firstError) firstError = e;
      }
    }

    if (firstError) {
      return { data: results.length > 0 ? results : null, error: firstError };
    }
    return { data: results, error: null };
  }

  /**
   * Get the public URL for a file. Does not verify the file exists.
   *
   * @param path - The path within the bucket
   * @returns The full public URL for the object
   */
  getPublicUrl(path: string): { data: { publicUrl: string } } {
    const encodedPath = path
      .split('/')
      .map(encodeURIComponent)
      .join('/');
    return {
      data: {
        publicUrl: `${this.url}/storage/v1/object/public/${encodeURIComponent(this.bucket)}/${encodedPath}`,
      },
    };
  }
}
