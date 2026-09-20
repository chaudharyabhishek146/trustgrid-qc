export type InspectionStatus =
  | 'pending_upload' | 'uploading' | 'ready' | 'processing'
  | 'completed' | 'needs_review' | 'failed';

export type AnalysisStatus =
  | 'succeeded' | 'failed_parse' | 'failed_api' | 'rejected_validation';

export interface PartTarget {
  partNumber: number;
  url: string;
  /** Byte range of the source blob this part carries. */
  rangeStart: number;
  rangeEnd: number;
}

export interface UploadTarget {
  imageId: string;
  sequenceNo: number;
  uploadId: string;
  storageKey: string;
  partSize: number;
  /** Parts still outstanding — the server omits anything already durable. */
  parts: PartTarget[];
  /** Parts storage already holds, with their ETags, so the client can include
   *  them in /complete without re-uploading. */
  uploadedParts: CompletedPart[];
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}
