import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanLibrary } from './scanner.js';
import { PlayerEngine } from './player.js';
import { createMusicScene } from './scene.js';

/** Cordis plugin identity used by Loader diagnostics. */
const name = 'music-player-tui';
// 服务一律 ctx.get 软取 + 装配层 inject 保证顺序（见 cordis.patch.yml 注释）：
// 代码级硬 inject 会在服务行缺失时把整棵装配树卡死在 boot（dsh-tui issue #183）。

// 状态文件：优先写用户目录，保持已安装包目录只读（artifact digest 可复验，
// TUI-DEP-001）；兼容读取 ≤0.2 版写在包内的 lib/state.json（读完即迁移，
// 下次持久化落入用户目录）。两处都不可写时降级为不持久化，不影响播放。
const PACKAGE_STATE_FILE = fileURLToPath(new URL('./state.json', import.meta.url));
const USER_STATE_DIR = path.join(os.homedir(), '.dsh-music-player-tui');
const USER_STATE_FILE = path.join(USER_STATE_DIR, 'state.json');
const LOOP_MODES = new Set(['list', 'one', 'off']);

async function loadState() {
  for (const file of [USER_STATE_FILE, PACKAGE_STATE_FILE]) {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      return typeof parsed === 'object' && parsed !== null ? parsed : null;
    } catch {
      // 尝试下一个候选位置。
    }
  }
  return null;
}

async function writeState(body) {
  try {
    await fs.mkdir(USER_STATE_DIR, { recursive: true });
    await fs.writeFile(USER_STATE_FILE, body, 'utf8');
  } catch {
    try {
      await fs.writeFile(PACKAGE_STATE_FILE, body, 'utf8');
    } catch {
      // 持久化是 best-effort：只读环境不能影响播放。
    }
  }
}

function expandTilde(input) {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~' + path.sep)) {
    return path.join(os.homedir(), input.slice(2));
  }
  return path.resolve(input);
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
async function apply(ctx) {
  const engine = new PlayerEngine();
  let currentDir = null;

  async function persist() {
    try {
      const payload = {
        dir: currentDir,
        volume: engine.volume,
        loopMode: engine.loopMode,
        lastTrackId: engine.currentId,
        lastPosition: engine.status === 'idle' ? 0 : Math.round(engine.position() * 10) / 10,
      };
      await writeState(JSON.stringify(payload, null, 2));
    } catch {
      // 持久化失败不影响播放。
    }
  }
  engine.onPersist = () => {
    void persist();
  };

  // 扫描序列号：只让最后一次 setDir/refresh 的结果落地，早前的扫描作废。
  let scanSeq = 0;

  async function setDir(dir, { cue } = {}) {
    const resolved = expandTilde(dir.trim());
    const stat = await fs.stat(resolved).catch(() => null);
    if (stat === null || !stat.isDirectory()) {
      const message = `目录不存在：${resolved}`;
      engine.setScanError(message);
      throw new Error(message);
    }
    const seq = ++scanSeq;
    engine.setScanError(null);
    engine.setScanning({ parsed: 0, total: 0 });
    try {
      const library = await scanLibrary(resolved, (parsed, total) => {
        if (seq === scanSeq) engine.setScanning({ parsed, total });
      });
      if (seq !== scanSeq) return; // 已被更新的扫描取代
      engine.setLibrary(library);
      currentDir = resolved;
      if (typeof cue?.id === 'string') engine.cue(cue.id, cue.position ?? 0);
      await persist();
    } catch (error) {
      if (seq === scanSeq) {
        const message = error instanceof Error ? error.message : String(error);
        engine.setScanError(message);
      }
      throw error;
    }
  }

  async function refresh() {
    if (currentDir === null) {
      engine.setScanError('尚未设置目录');
      return;
    }
    await setDir(currentDir);
  }

  /**
   * 删除曲目（含本地文件，不可恢复）。只允许删当前库里的曲目：先按稳定 id
   * 命中扫描列表，再做越界校验——库外路径根本到不了 unlink（与 web 版同款）。
   */
  async function deleteTrack(id) {
    const library = engine.library;
    if (library === null) throw new Error('尚未选择音乐目录');
    const track = engine.trackById(id);
    if (track === null) throw new Error('曲目不在当前库中');
    const resolved = path.resolve(library.dir, id);
    const rootWithSep = library.dir.endsWith(path.sep) ? library.dir : library.dir + path.sep;
    if (id.length === 0 || (resolved !== library.dir && !resolved.startsWith(rootWithSep)) || path.resolve(track.path) !== resolved) {
      throw new Error('路径越界，已拒绝删除');
    }
    try {
      await fs.unlink(track.path);
    } catch {
      throw new Error('无法删除文件：' + track.name);
    }
    engine.removeTrack(id);
    return track;
  }

  // ── 启动恢复：音量/循环模式/上次的目录与曲目（暂停态 cue 在原位置） ──
  const saved = await loadState();
  if (saved !== null) {
    if (typeof saved.volume === 'number' && Number.isFinite(saved.volume)) {
      engine.volume = Math.max(0, Math.min(100, Math.round(saved.volume)));
    }
    if (typeof saved.loopMode === 'string' && LOOP_MODES.has(saved.loopMode)) {
      engine.loopMode = saved.loopMode;
    }
    if (typeof saved.dir === 'string' && saved.dir.length > 0) {
      void setDir(saved.dir, {
        cue: { id: saved.lastTrackId, position: typeof saved.lastPosition === 'number' ? saved.lastPosition : 0 },
      }).catch(() => {
        // setDir 已把错误写进 scanError，场景状态行会显示。
      });
    }
  }

  const scenes = ctx.get('tuiScenes');
  const commands = ctx.get('commands');
  const trees = ctx.get('tuiCommandTrees');

  /** /music 命令：无参打开场景；带子命令直接驱动播放器。 */
  async function handler(invocation) {
    const input = invocation.rawInput.trim();
    if (input.length === 0) {
      if (scenes === undefined || scenes === null) {
        return { kind: 'error', text: '当前环境没有 tuiScenes 服务（需要 dsh-tui ≥ 0.8，且装配层挂载 scenes 行）' };
      }
      return scenes.open('music-player')
        ? { kind: 'success' }
        : { kind: 'error', text: '音乐场景未注册' };
    }
    const spaceIndex = input.search(/\s/);
    const sub = (spaceIndex === -1 ? input : input.slice(0, spaceIndex)).toLowerCase();
    const arg = spaceIndex === -1 ? '' : input.slice(spaceIndex + 1).trim();
    switch (sub) {
      case 'dir': {
        if (arg.length === 0) return { kind: 'error', text: '用法：/music dir <路径>' };
        try {
          await setDir(arg);
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
        }
        const count = engine.library?.tracks.length ?? 0;
        return { kind: 'success', text: `音乐目录：${engine.library?.dir}（${count} 首）` };
      }
      case 'play': {
        if (arg.length > 0) {
          const keyword = arg.toLowerCase();
          const hit = engine.library?.tracks.find(
            (track) =>
              track.title.toLowerCase().includes(keyword) ||
              (track.artist ?? '').toLowerCase().includes(keyword) ||
              track.name.toLowerCase().includes(keyword),
          );
          if (hit === undefined || hit === null) return { kind: 'error', text: `没有匹配“${arg}”的曲目` };
          await engine.play(hit.id);
          return { kind: 'success', text: `▶ ${hit.title}${hit.artist ? ' — ' + hit.artist : ''}` };
        }
        await engine.play();
        return { kind: 'success' };
      }
      case 'pause':
        engine.pause();
        return { kind: 'success' };
      case 'next':
        await engine.next();
        return { kind: 'success' };
      case 'prev':
        await engine.prev();
        return { kind: 'success' };
      case 'vol': {
        const value = Number(arg);
        if (!Number.isFinite(value)) return { kind: 'error', text: '用法：/music vol <0-100>' };
        engine.setVolume(value);
        return { kind: 'success', text: `音量 ${engine.volume}%` };
      }
      case 'refresh': {
        if (currentDir === null) return { kind: 'error', text: '尚未设置目录（/music dir <路径>）' };
        try {
          await refresh();
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
        }
        return { kind: 'success', text: `已重新扫描（${engine.library?.tracks.length ?? 0} 首）` };
      }
      case 'delete': {
        if (arg.length === 0) return { kind: 'error', text: '用法：/music delete <关键词>' };
        if (engine.library === null) return { kind: 'error', text: '尚未设置目录（/music dir <路径>）' };
        const keyword = arg.toLowerCase();
        const matches = engine.library.tracks.filter(
          (track) =>
            track.title.toLowerCase().includes(keyword) ||
            (track.artist ?? '').toLowerCase().includes(keyword) ||
            track.name.toLowerCase().includes(keyword),
        );
        if (matches.length === 0) return { kind: 'error', text: `没有匹配“${arg}”的曲目` };
        if (matches.length > 1) {
          const sample = matches.slice(0, 3).map((track) => track.title).join(' / ');
          return { kind: 'error', text: `匹配到 ${matches.length} 首（${sample}…），关键词再具体一点` };
        }
        try {
          const track = await deleteTrack(matches[0].id);
          return { kind: 'success', text: `已删除：${track.title}${track.artist ? ' — ' + track.artist : ''}` };
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
        }
      }
      default:
        return { kind: 'error', text: `未知子命令：${sub}（可用 dir / play [关键词] / pause / next / prev / vol / refresh / delete）` };
    }
  }

  ctx.effect(() => {
    const disposers = [];
    if (scenes !== undefined && scenes !== null) {
      disposers.push(
        scenes.register({
          id: 'music-player',
          title: '音乐',
          component: createMusicScene(engine, {
            setDir: (dir) => setDir(dir),
            refresh,
            deleteTrack,
          }),
        }),
      );
    }
    if (commands !== undefined && commands !== null) {
      disposers.push(
        commands.register({
          name: 'music',
          description: 'open the local music player (browse a folder, play, loop)',
          input: { hint: '[dir <路径>|play [关键词]|pause|next|prev|vol <0-100>|refresh|delete <关键词>]' },
          handler,
        }),
      );
    }
    if (trees !== undefined && trees !== null) {
      disposers.push(
        trees.register({
          root: 'music',
          descriptions: { zh: '打开本地音乐播放器', en: 'open the local music player' },
          children: (canonicalPath) =>
            canonicalPath.length === 1
              ? [
                  { name: 'dir', description: 'set music folder and scan', descriptions: { zh: '设置音乐目录并扫描' } },
                  { name: 'play', description: 'play current/first or first keyword match', descriptions: { zh: '播放当前/首个匹配曲目' } },
                  { name: 'pause', description: 'pause or resume', descriptions: { zh: '暂停/继续' } },
                  { name: 'next', description: 'next track', descriptions: { zh: '下一首' } },
                  { name: 'prev', description: 'previous track', descriptions: { zh: '上一首' } },
                  { name: 'vol', description: 'set volume 0-100', descriptions: { zh: '设置音量 0-100' } },
                  { name: 'refresh', description: 'rescan the folder', descriptions: { zh: '重新扫描目录' } },
                  { name: 'delete', description: 'delete track file by keyword (unique match)', descriptions: { zh: '按关键词删除曲目文件（需唯一匹配）' } },
                ]
              : [],
        }),
      );
    }
    return () => {
      for (const dispose of disposers.splice(0)) dispose();
      engine.dispose();
    };
  }, 'music-player-tui: /music command + full-screen scene');
}

export { apply, name };
