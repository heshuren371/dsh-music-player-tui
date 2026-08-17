import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseFile } from 'music-metadata';

/** Common audio formats the local backends (ffplay/afplay) can decode. */
export const AUDIO_EXTENSIONS = new Map([
  ['.mp3', 'audio/mpeg'],
  ['.flac', 'audio/flac'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.ogg', 'audio/ogg'],
  ['.oga', 'audio/ogg'],
  ['.opus', 'audio/ogg'],
  ['.wav', 'audio/wav'],
  ['.wave', 'audio/wav'],
]);

const MAX_TRACKS = 5000;
const MAX_SCAN_DEPTH = 6;
const SCAN_VISIT_LIMIT = 20000;
const METADATA_CONCURRENCY = 8;
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn']);

/** Recursively collect audio files under dir (skip hidden entries and tooling dirs). */
async function collectAudioFiles(dir) {
  const files = [];
  let truncated = false;
  const stack = [{ directory: dir, depth: 0 }];
  let visited = 0;
  while (stack.length > 0 && visited < SCAN_VISIT_LIMIT) {
    if (files.length >= MAX_TRACKS) {
      truncated = true;
      break;
    }
    const current = stack.pop();
    visited += 1;
    let rows;
    try {
      rows = await fs.readdir(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const row of rows) {
      if (row.name.startsWith('.')) continue;
      const absolute = path.join(current.directory, row.name);
      if (row.isDirectory()) {
        if (current.depth < MAX_SCAN_DEPTH && !SKIP_DIRS.has(row.name)) {
          stack.push({ directory: absolute, depth: current.depth + 1 });
        }
        continue;
      }
      if (!row.isFile()) continue;
      const mime = AUDIO_EXTENSIONS.get(path.extname(row.name).toLowerCase());
      if (mime === undefined) continue;
      files.push({ path: absolute, mime });
    }
  }
  // 深度优先扫描因访问上限提前退出时（目录栈仍非空），同样要标记截断，
  // 否则 UI 会把它当成一次完整扫描。
  if (!truncated && visited >= SCAN_VISIT_LIMIT && stack.length > 0) {
    truncated = true;
  }
  files.sort((left, right) => left.path.localeCompare(right.path, 'zh-Hans-CN', { numeric: true }));
  return { files, truncated };
}

function fallbackTitle(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  // Common "Artist - Title" file naming: prefer the title half for the name column.
  const dash = base.indexOf(' - ');
  return dash > 0 ? base.slice(dash + 3).trim() || base : base;
}

function fallbackArtist(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  const dash = base.indexOf(' - ');
  return dash > 0 ? base.slice(0, dash).trim() || null : null;
}

async function readMetadata(file) {
  const track = {
    path: file.path,
    name: path.basename(file.path),
    title: fallbackTitle(file.path),
    artist: fallbackArtist(file.path),
    duration: null,
    mime: file.mime,
  };
  try {
    const metadata = await parseFile(file.path, { duration: true, skipCovers: true });
    const common = metadata.common;
    if (typeof common.title === 'string' && common.title.trim().length > 0) track.title = common.title.trim();
    const artist = common.artist ?? (Array.isArray(common.artists) ? common.artists[0] : undefined);
    if (typeof artist === 'string' && artist.trim().length > 0) track.artist = artist.trim();
    if (typeof metadata.format.duration === 'number' && Number.isFinite(metadata.format.duration)) {
      track.duration = Math.round(metadata.format.duration * 10) / 10;
    }
  } catch {
    // Unparseable/corrupt tags still list and play; fall back to filename info.
  }
  return track;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const current = next;
      next += 1;
      if (current >= items.length) return;
      results[current] = await worker(items[current], current);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Scan dir into a library: { dir, tracks, truncated, scannedAt }.
 * Track identity is the path relative to the library root — stable across
 * rescans and reordering, unlike an array index. onProgress(parsed, total)
 * fires as metadata parsing advances.
 */
export async function scanLibrary(dir, onProgress) {
  const { files, truncated } = await collectAudioFiles(dir);
  let parsed = 0;
  const tracks = await mapLimit(files, METADATA_CONCURRENCY, async (file) => {
    const track = await readMetadata(file);
    parsed += 1;
    if (typeof onProgress === 'function') onProgress(parsed, files.length);
    return track;
  });
  for (const track of tracks) {
    track.id = path.relative(dir, track.path).split(path.sep).join('/');
  }
  return { dir, tracks, truncated, scannedAt: Date.now() };
}
