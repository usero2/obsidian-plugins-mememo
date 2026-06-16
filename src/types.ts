/** Attachment held in memory before the memo is saved */
export interface PendingAttachment {
  id: string;
  type: 'image' | 'video' | 'file' | 'audio';
  name: string;
  size: number;
  dataUrl: string; // base64, used for preview only
}

/** Attachment that has been written to _mememo/assets/ */
export interface MemoAttachment {
  id: string;
  type: 'image' | 'video' | 'file' | 'audio';
  name: string;
  vaultPath: string; // e.g. _mememo/assets/1718531400123-photo.png
}

/** One memo = one .md file inside _mememo/ */
export interface Memo {
  filePath: string;          // e.g. _mememo/1718531400123.md
  content: string;           // body text (no ![[]] attachment refs)
  attachments: MemoAttachment[];
  tags: string[];
  createdAt: number;
  updatedAt: number;
  isPrivate: boolean;
}
