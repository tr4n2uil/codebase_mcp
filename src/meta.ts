import fs from 'node:fs/promises';
import path from 'node:path';

export interface MetaFile {
  embeddingModel: string;
  embeddingDim: number;
  watchRoot: string;
  lastFullScanAt: string | null;
  /** Relative POSIX path -> sha256 hex of file content */
  fileHashes: Record<string, string>;
}

export async function readMeta(metaPathAbs: string): Promise<MetaFile | null> {
  try {
    const raw = await fs.readFile(metaPathAbs, 'utf8');
    const parsed = JSON.parse(raw) as MetaFile;
    if (typeof parsed.fileHashes !== 'object' || parsed.fileHashes === null) {
      parsed.fileHashes = {};
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function writeMeta(metaPathAbs: string, meta: MetaFile): Promise<void> {
  await fs.mkdir(path.dirname(metaPathAbs), { recursive: true });
  await fs.writeFile(metaPathAbs, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}
