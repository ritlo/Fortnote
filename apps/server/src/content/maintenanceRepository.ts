export interface ExpiredContentUpload {
  uploadId: string;
  storageKeys: string[];
}

export interface ExpiredContentUploadPage {
  uploads: ExpiredContentUpload[];
  hasMore: boolean;
}

export interface StorageObjectCleanupPage {
  scanned: number;
  removed: number;
  done: boolean;
}

export interface StorageAccountReconciliationPage {
  processed: number;
  hasMore: boolean;
  nextUserId: string | null;
}

export interface ContentMaintenanceRepository {
  expireUploads(cutoff: string, limit: number): Promise<ExpiredContentUploadPage>;
  canRemoveUpload(uploadId: string): Promise<boolean>;
  removeOrphanObjects(cutoff: string, limit: number): Promise<StorageObjectCleanupPage>;
  reconcileStorageAccounts(
    afterUserId: string | null,
    limit: number
  ): Promise<StorageAccountReconciliationPage>;
}
