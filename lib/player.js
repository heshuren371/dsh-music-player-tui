import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { accessSync, constants, promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/**
 * 播放后端探测：mpv 优先（JSON IPC 常驻进程：换歌不重启解码、暂停无爆音、
 * seek/音量即时写入、time-pos 精确进度），ffplay 备选（全格式 + -ss 快进快退），
 * afplay 兜底（macOS 自带；无 seek，音量在下次起播时生效）。
 */
function runnable(cmd, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: 'ignore' });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(false);
    }, 3000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

export async function detectBackend() {
  if (await runnable('mpv', ['--version'])) return 'mpv';
  if (await runnable('ffplay', ['-version'])) return 'ffplay';
  // afplay 几乎只存在于 macOS 且固定在 /usr/bin；-h 退出码不可靠，直接看路径。
  try {
    accessSync('/usr/bin/afplay', constants.X_OK);
    return 'afplay';
  } catch {
    return null;
  }
}

const TICK_MS = 250;
/** 起播偏移低于这个量就不值得再补一刀 seek。 */
const MIN_OFFSET_SEC = 0.3;
/** 2 秒内连续起播失败达到这次数就停住——避免一批坏文件刷屏空转。 */
const MAX_ERROR_STRIKES = 3;

/**
 * mpv JSON IPC 客户端（--idle 常驻进程 + unix socket / Windows 命名管道）。
 * 换歌 = loadfile（进程不重启，切歌无间隙）；暂停/音量/seek = 属性写入即时
 * 生效——从根上消掉 SIGSTOP 冻结音频缓冲的爆音，以及「调音量/seek 杀掉进程
 * 重新解码」的接缝。
 */
class MpvIpc extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.socket = null;
    this.requestSeq = 0;
    this.pending = new Map();
    this.buffer = '';
    this.deadEmitted = false;
  }

  static socketPath() {
    const id = `dsh-music-mpv-${process.pid}`;
    return process.platform === 'win32' ? `\\\\.\\pipe\\${id}` : path.join(os.tmpdir(), `${id}.sock`);
  }

  /** 拉起进程并连上 socket 才算就绪；失败抛错（调用方提示/降级）。 */
  async ensure() {
    if (this.proc !== null && this.socket !== null) return;
    const sockPath = MpvIpc.socketPath();
    if (process.platform !== 'win32') await fs.rm(sockPath, { force: true }).catch(() => undefined);
    let proc;
    try {
      proc = spawn(
        'mpv',
        [
          '--idle=yes',
          '--force-window=no',
          '--no-video',
          '--no-terminal',
          '--really-quiet',
          `--input-ipc-server=${sockPath}`,
        ],
        { stdio: 'ignore' },
      );
    } catch (error) {
      throw new Error(`mpv 启动失败：${error instanceof Error ? error.message : String(error)}`);
    }
    this.proc = proc;
    proc.once('error', () => this._teardown());
    proc.once('exit', () => this._teardown());
    const deadline = Date.now() + 5000;
    for (;;) {
      if (this.proc === null) throw new Error('mpv 进程提前退出');
      try {
        await this._connect(sockPath);
        return;
      } catch {
        if (Date.now() >= deadline) {
          this._teardown();
          throw new Error('mpv IPC 连接超时');
        }
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
    }
  }

  _connect(sockPath) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(sockPath);
      const onError = (error) => {
        socket.destroy();
        reject(error);
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.off('error', onError);
        this.socket = socket;
        this.buffer = '';
        socket.on('data', (chunk) => this._onData(chunk));
        socket.on('error', () => this._teardown());
        socket.on('close', () => this._teardown());
        resolve();
      });
    });
  }

  _onData(chunk) {
    this.buffer += chunk.toString('utf8');
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline === -1) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length === 0) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof message.request_id === 'number' && this.pending.has(message.request_id)) {
        const { resolve, reject } = this.pending.get(message.request_id);
        this.pending.delete(message.request_id);
        if (message.error === undefined || message.error === 'success') resolve(message.data);
        else reject(new Error(String(message.error)));
        continue;
      }
      if (message.event === 'end-file') this.emit('end-file', message);
      else if (message.event === 'file-loaded') this.emit('file-loaded', message);
    }
  }

  /** command(['set_property', 'pause', true]) → resolve(data) / reject(错误串)。 */
  command(args) {
    const socket = this.socket;
    if (socket === null) return Promise.reject(new Error('mpv 未连接'));
    const id = ++this.requestSeq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.write(`${JSON.stringify({ command: args, request_id: id })}\n`);
    });
  }

  _teardown() {
    const wasUp = this.proc !== null || this.socket !== null;
    if (this.socket !== null) {
      this.socket.destroy();
      this.socket = null;
    }
    if (this.proc !== null) {
      try {
        this.proc.kill('SIGKILL');
      } catch {
        // 已退出。
      }
      this.proc = null;
    }
    for (const { reject } of this.pending.values()) reject(new Error('mpv 连接断开'));
    this.pending.clear();
    if (wasUp && !this.deadEmitted) {
      this.deadEmitted = true;
      this.emit('dead');
    }
  }

  dispose() {
    if (this.socket !== null) {
      try {
        this.socket.write(`${JSON.stringify({ command: ['quit'] })}\n`);
      } catch {
        // 已断开。
      }
    }
    this._teardown();
  }
}

export class PlayerEngine extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(20);
    /** @type {'mpv' | 'ffplay' | 'afplay' | null} */
    this.backend = null;
    this.backendChecked = false;
    this.ready = this._detect();

    this.library = null;
    this.scanning = null; // { parsed, total } | null
    this.scanError = null;
    /** 可见列表顺序（排序/搜索后的曲目 id）；next/prev 严格按它走。 */
    this.order = [];

    this.currentId = null;
    /** @type {'idle' | 'playing' | 'paused'} */
    this.status = 'idle';
    /** @type {'list' | 'one' | 'off'} */
    this.loopMode = 'list';
    this.volume = 80;
    /** 一次性提示（错误/后端限制），下一次成功起播清除。 */
    this.hint = null;

    this.child = null;
    // 旧进程退出事件的判活方式：exit 闭包捕获自己的 child，与 this.child
    // 比对——不等说明已被新起播/换曲取代，事件直接丢弃。比 manualStop 标志
    // 可靠：标志会被紧接着的新起播重置，旧 exit 晚一拍到时无法分辨。
    this.disposed = false;
    this.frozenSec = 0; // ffplay/afplay：暂停/起播基准偏移
    this.playingSince = null; // status==='playing' 时的起播墙钟
    this.timer = null;
    /** 宿主（index.js）挂的持久化回调，在关键时刻调用（不含 tick）。 */
    this.onPersist = null;

    // ── mpv 专用 ──
    this._mpv = null;
    this._mpvEnsure = null;
    this._mpvLoadedId = null; // 当前 loadfile 成功的曲目；stop/替换后清空
    this.ipcPos = null; // { pos, at }：最近一次 time-pos 回报 + 本地墙钟

    // 连坏保护：快速连续起播失败视为批量坏文件，停住而不是无限接力。
    this.lastStartAt = 0;
    this.errorStrikes = 0;
  }

  async _detect() {
    this.backend = await detectBackend();
    this.backendChecked = true;
    if (this.backend === null) {
      this.hint = '未找到播放器：请安装 mpv（brew install mpv）或 ffmpeg';
    }
    this._emit();
  }

  // ── 库与扫描状态（由 index.js 喂入） ─────────────────────────────────

  setLibrary(library) {
    this.library = library;
    this.scanning = null;
    this.scanError = null;
    const ids = library === null ? [] : library.tracks.map((track) => track.id);
    // 换库后旧 order 整体失效；当前曲目若已不在新库，cue 到第一首。
    this.order = this.order.filter((id) => ids.includes(id));
    if (this.order.length === 0) this.order = ids;
    if (this.currentId !== null && !ids.includes(this.currentId)) {
      this._killChild();
      this.status = 'idle';
      this.frozenSec = 0;
      this.ipcPos = null;
      this.currentId = ids[0] ?? null;
    }
    this._emit();
  }

  setScanning(progress) {
    this.scanning = progress; // null 表示扫描结束
    this._emit();
  }

  setScanError(message) {
    this.scanning = null;
    this.scanError = message;
    this._emit();
  }

  /** 场景每次算出可见顺序后调用；内部做相等性检查，相同则 no-op。 */
  setOrder(ids) {
    if (ids.length === this.order.length && ids.every((id, index) => id === this.order[index])) return;
    this.order = ids.slice();
  }

  // ── 状态快照 ─────────────────────────────────────────────────────────

  trackById(id) {
    if (this.library === null || id === null) return null;
    return this.library.tracks.find((track) => track.id === id) ?? null;
  }

  position() {
    if (this.status === 'idle') return 0;
    if (this.backend === 'mpv') {
      // 精确锚点 + 墙钟外推：两次轮询之间也平滑。
      if (this.ipcPos === null) return 0;
      const track = this.trackById(this.currentId);
      let value = this.ipcPos.pos + (this.status === 'playing' ? (Date.now() - this.ipcPos.at) / 1000 : 0);
      if (track?.duration != null) value = Math.min(value, track.duration);
      return Math.max(0, value);
    }
    if (this.status === 'playing' && this.playingSince !== null) {
      const track = this.trackById(this.currentId);
      const elapsed = this.frozenSec + (Date.now() - this.playingSince) / 1000;
      // 时长已知则钳住显示，自然结束事件马上会接力推进。
      if (track?.duration != null) return Math.min(elapsed, track.duration);
      return elapsed;
    }
    return this.frozenSec;
  }

  getState() {
    const track = this.trackById(this.currentId);
    return {
      backend: this.backend,
      backendChecked: this.backendChecked,
      status: this.status,
      currentId: this.currentId,
      track,
      position: this.position(),
      duration: track?.duration ?? null,
      volume: this.volume,
      loopMode: this.loopMode,
      library: this.library,
      scanning: this.scanning,
      scanError: this.scanError,
      hint: this.hint,
    };
  }

  // ── 播放控制 ─────────────────────────────────────────────────────────

  async play(id) {
    await this.ready;
    if (this.backend === null) {
      this.hint = '未找到播放器：请安装 mpv（brew install mpv）或 ffmpeg';
      this._emit();
      return false;
    }
    const targetId = id ?? this.currentId ?? this.order[0] ?? this.library?.tracks[0]?.id ?? null;
    const track = this.trackById(targetId);
    if (track === null) {
      this.hint = this.library === null ? '尚未选择音乐目录（按 u 输入路径）' : '曲目不在当前库中';
      this._emit();
      return false;
    }
    if (track.id === this.currentId && this.status === 'paused') {
      return this.resume();
    }
    this._start(track, 0);
    return true;
  }

  toggle() {
    if (this.status === 'playing') return this.pause();
    if (this.status === 'paused') return this.resume();
    return this.play();
  }

  pause() {
    if (this.status !== 'playing') return false;
    if (this.backend === 'mpv') {
      // 属性写入即停：音频设备干净挂起，没有 SIGSTOP 冻结缓冲的爆音。
      const now = this.position();
      this.ipcPos = { pos: now, at: Date.now() };
      this.status = 'paused';
      if (this._mpv !== null && this._mpvLoadedId === this.currentId) {
        void this._mpv.command(['set_property', 'pause', true]).catch(() => {});
      }
      this._stopTimer();
      this._emit();
      this._persist();
      return true;
    }
    if (process.platform === 'win32') {
      this.hint = 'Windows 暂不支持暂停（无 SIGSTOP）；安装 mpv 可解';
      this._emit();
      return false;
    }
    this.frozenSec = this.position();
    this.playingSince = null;
    this.status = 'paused';
    if (this.child !== null) {
      try {
        this.child.kill('SIGSTOP');
      } catch {
        // 进程已死：child 置空，resume 时从冻结位置重新起播。
        this.child = null;
      }
    }
    this._stopTimer();
    this._emit();
    this._persist();
    return true;
  }

  resume() {
    if (this.status !== 'paused') return false;
    const track = this.trackById(this.currentId);
    if (track === null) return false;
    if (this.backend === 'mpv') {
      if (this._mpv === null || this._mpvLoadedId !== this.currentId) {
        // cue 态 / 进程没了：从冻结位置 loadfile 起播。
        this._start(track, this.ipcPos?.pos ?? this.frozenSec);
        return true;
      }
      if (this.ipcPos !== null) this.ipcPos = { pos: this.ipcPos.pos, at: Date.now() };
      void this._mpv.command(['set_property', 'pause', false]).catch(() => {});
      this.status = 'playing';
      this._startTimer();
      this._emit();
      this._persist();
      return true;
    }
    if (this.child === null) {
      // seek/换卷后起播点：从冻结位置重新解码。
      this._start(track, this.frozenSec);
      return true;
    }
    try {
      this.child.kill('SIGCONT');
    } catch {
      this._start(track, this.frozenSec);
      return true;
    }
    this.status = 'playing';
    this.playingSince = Date.now();
    this._startTimer();
    this._emit();
    this._persist();
    return true;
  }

  stop() {
    this._killChild();
    this.status = 'idle';
    this.frozenSec = 0;
    this.playingSince = null;
    this.ipcPos = null;
    this._emit();
    this._persist();
  }

  /**
   * 以暂停态把曲目 cue 在指定位置（不开声）：用于重启后恢复上次播放。
   * resume/play 会从冻结位置重新起播。
   */
  cue(id, positionSec = 0) {
    if (this.trackById(id) === null) return false;
    this._killChild();
    this.currentId = id;
    this.status = 'paused';
    this.frozenSec = positionSec > 0 ? positionSec : 0;
    this.playingSince = null;
    this.ipcPos = { pos: this.frozenSec, at: Date.now() };
    this._emit();
    return true;
  }

  /** auto=true 表示自然结束接力：尊重 loopMode；手动切换永远环绕。 */
  next(auto = false) {
    const ids = this.order.filter((id) => this.trackById(id) !== null);
    if (ids.length === 0) return false;
    const index = ids.indexOf(this.currentId);
    if (index === -1) {
      return this.play(ids[0]);
    }
    const atEnd = index + 1 >= ids.length;
    if (auto && atEnd && this.loopMode === 'off') {
      this.stop();
      return false;
    }
    const target = ids[(index + 1) % ids.length];
    return this.play(target);
  }

  prev() {
    const ids = this.order.filter((id) => this.trackById(id) !== null);
    if (ids.length === 0) return false;
    const index = ids.indexOf(this.currentId);
    const target = index <= 0 ? ids[ids.length - 1] : ids[index - 1];
    return this.play(target);
  }

  /** 相对 seek（秒）。mpv/ffplay 支持；afplay 不支持。 */
  seek(deltaSec) {
    const track = this.trackById(this.currentId);
    if (track === null || this.status === 'idle') return false;
    if (this.backend === 'mpv') {
      if (this._mpv !== null && this._mpvLoadedId === this.currentId) {
        const ipc = this._mpv;
        // 相对 seek 即时生效（暂停中 seek 也保持暂停），随后回报精确位置。
        void ipc
          .command(['seek', deltaSec, 'relative'])
          .then(() => (this._mpv === ipc ? ipc.command(['get_property', 'time-pos']) : null))
          .then((pos) => {
            if (typeof pos === 'number') {
              this.ipcPos = { pos, at: Date.now() };
              this._emit();
              this._persist();
            }
          })
          .catch(() => {});
      } else {
        // cue 态：只挪冻结位置，resume 时从这里起播。
        const ceiling = track.duration ?? Number.MAX_SAFE_INTEGER;
        const target = Math.max(0, Math.min(this.position() + deltaSec, ceiling));
        this.ipcPos = { pos: target, at: Date.now() };
        this.frozenSec = target;
        this._emit();
        this._persist();
      }
      return true;
    }
    if (this.backend !== 'ffplay') {
      this.hint = `当前后端（${this.backend ?? '无'}）不支持快进快退，安装 mpv 或 ffmpeg 即可`;
      this._emit();
      return false;
    }
    const ceiling = track.duration ?? Number.MAX_SAFE_INTEGER;
    const target = Math.max(0, Math.min(this.position() + deltaSec, ceiling));
    if (this.status === 'playing') {
      this._start(track, target);
    } else {
      // 暂停中 seek：停掉旧进程，resume 时从目标位置起播。
      this._killChild();
      this.frozenSec = target;
      this._emit();
      this._persist();
    }
    return true;
  }

  setVolume(value) {
    const clamped = Math.max(0, Math.min(100, Math.round(value)));
    if (clamped === this.volume) return;
    this.volume = clamped;
    if (this.backend === 'mpv') {
      // 属性写入即时生效，暂停中调好下次继续也保持——不再重启解码。
      if (this._mpv !== null && this.status !== 'idle') {
        void this._mpv.command(['set_property', 'volume', clamped]).catch(() => {});
      }
    } else if (this.status === 'playing') {
      const track = this.trackById(this.currentId);
      if (this.backend === 'ffplay' && track !== null) {
        // ffplay 音量是启动参数：带当前位置重启，听感上是一个极短的接续。
        this._start(track, this.position());
      } else if (this.backend === 'afplay') {
        this.hint = 'afplay 音量将在下次起播时生效';
      }
    }
    this._emit();
    this._persist();
  }

  cycleLoopMode() {
    this.loopMode = this.loopMode === 'list' ? 'one' : this.loopMode === 'one' ? 'off' : 'list';
    this._emit();
    this._persist();
    return this.loopMode;
  }

  /**
   * 从库里移除曲目（文件删除由调用方完成）。被删的是当前曲目时停声，
   * 并把光标 cue 到可见顺序里原位置的下一首。
   */
  removeTrack(id) {
    if (this.library === null) return null;
    const index = this.library.tracks.findIndex((track) => track.id === id);
    if (index === -1) return null;
    const [track] = this.library.tracks.splice(index, 1);
    this.library.scannedAt = Date.now();
    const orderIndex = this.order.indexOf(id);
    this.order = this.order.filter((item) => item !== id);
    if (this.currentId === id) {
      this._killChild();
      this.status = 'idle';
      this.frozenSec = 0;
      this.playingSince = null;
      this.ipcPos = null;
      this.currentId =
        this.order.length > 0
          ? this.order[Math.min(Math.max(orderIndex, 0), this.order.length - 1)]
          : (this.library.tracks[0]?.id ?? null);
    }
    this._emit();
    this._persist();
    return track;
  }

  dispose() {
    this.disposed = true;
    if (this._mpv !== null) {
      this._mpv.dispose();
      this._mpv = null;
    }
    this._killChild();
    this._stopTimer();
    this.removeAllListeners();
  }

  // ── 内部 ─────────────────────────────────────────────────────────────

  _start(track, offsetSec) {
    this._killChild();
    this.hint = null;
    this.lastStartAt = Date.now();
    if (this.backend === 'mpv') {
      // 状态先行（UI 立刻有反馈），IPC 异步落地；常驻进程不切歌就不断声。
      this.currentId = track.id;
      this.status = 'playing';
      this.frozenSec = offsetSec;
      this.playingSince = Date.now();
      this.ipcPos = { pos: offsetSec, at: Date.now() };
      this._startTimer();
      this._emit();
      this._persist();
      void this._mpvStart(track, offsetSec);
      return;
    }
    const args =
      this.backend === 'ffplay'
        ? [
            '-nodisp',
            '-autoexit',
            '-loglevel',
            'error',
            '-volume',
            String(this.volume),
            ...(offsetSec > MIN_OFFSET_SEC ? ['-ss', offsetSec.toFixed(1)] : []),
            track.path,
          ]
        : ['-v', (this.volume / 100).toFixed(2), track.path];
    let child;
    try {
      child = spawn(this.backend, args, { stdio: 'ignore' });
    } catch (error) {
      this.hint = `起播失败：${error instanceof Error ? error.message : String(error)}`;
      this.status = 'idle';
      this._emit();
      return;
    }
    this.child = child;
    this.currentId = track.id;
    this.status = 'playing';
    this.frozenSec = offsetSec;
    this.playingSince = Date.now();
    child.once('error', (error) => {
      if (child !== this.child || this.disposed) return;
      this.hint = `播放器错误：${error.message}`;
      this._emit();
    });
    child.once('exit', (code) => {
      if (child !== this.child || this.disposed) return;
      this.child = null;
      this.playingSince = null;
      const errorHint = typeof code === 'number' && code !== 0 ? `播放器退出码 ${code}：${track.name}` : null;
      this._onNaturalEnd(errorHint);
    });
    this._startTimer();
    this._emit();
    this._persist();
  }

  async _mpvStart(track, offsetSec) {
    let ipc;
    try {
      ipc = await this._ensureMpv();
    } catch (error) {
      if (this.disposed) return;
      this.hint = error instanceof Error ? error.message : String(error);
      this.status = 'idle';
      this._stopTimer();
      this._emit();
      return;
    }
    // 连接期间用户已切歌/停止：本次起播作废。
    if (this.disposed || this.currentId !== track.id || this.status !== 'playing') return;
    try {
      if (offsetSec > MIN_OFFSET_SEC) {
        // 起播偏移：等 file-loaded 再 absolute seek（先挂监听再 loadfile，避免竞态）。
        ipc.once('file-loaded', () => {
          void ipc.command(['seek', offsetSec, 'absolute']).catch(() => {});
        });
      }
      await ipc.command(['set_property', 'volume', this.volume]);
      await ipc.command(['set_property', 'pause', false]);
      await ipc.command(['loadfile', track.path, 'replace']);
      if (this.currentId !== track.id) return; // await 期间被新起播取代
      this._mpvLoadedId = track.id;
      // 回报一次真实位置，纠正外推误差。
      void ipc
        .command(['get_property', 'time-pos'])
        .then((pos) => {
          if (typeof pos === 'number' && this._mpvLoadedId === track.id) {
            this.ipcPos = { pos, at: Date.now() };
            this._emit();
          }
        })
        .catch(() => {});
    } catch (error) {
      if (this.disposed || this.currentId !== track.id) return;
      this.hint = `起播失败：${error instanceof Error ? error.message : String(error)}`;
      this.status = 'idle';
      this._stopTimer();
      this._emit();
    }
  }

  _ensureMpv() {
    if (this._mpv !== null && this._mpv.socket !== null) return Promise.resolve(this._mpv);
    if (this._mpvEnsure !== null) return this._mpvEnsure;
    this._mpvEnsure = (async () => {
      if (this._mpv === null) {
        this._mpv = new MpvIpc();
        this._mpv.on('end-file', (message) => this._onMpvEndFile(message));
        this._mpv.on('dead', () => {
          this._mpv = null;
          this._mpvLoadedId = null;
          if (this.disposed) return;
          if (this.status !== 'idle') {
            this.hint = 'mpv 进程异常退出';
            this.status = 'idle';
            this._stopTimer();
            this._emit();
          }
        });
      }
      try {
        await this._mpv.ensure();
      } finally {
        this._mpvEnsure = null;
      }
      return this._mpv;
    })();
    return this._mpvEnsure;
  }

  _onMpvEndFile(message) {
    if (this.disposed || this.backend !== 'mpv') return;
    const reason = message?.reason;
    // stop / quit / redirect 都是自己 loadfile/stop 触发的，不算自然结束。
    if (reason === 'eof') {
      this._mpvLoadedId = null;
      this._onNaturalEnd(null);
    } else if (reason === 'error') {
      this._mpvLoadedId = null;
      const detail = typeof message?.file_error === 'string' ? message.file_error : '无法解码';
      this._onNaturalEnd(`播放失败：${detail}`);
    }
  }

  /** 自然结束接力：循环模式 + 连坏保护，ffplay exit 与 mpv end-file 共用。 */
  _onNaturalEnd(errorHint) {
    const now = Date.now();
    this.errorStrikes = now - this.lastStartAt < 2000 ? this.errorStrikes + 1 : 0;
    if (this.errorStrikes >= MAX_ERROR_STRIKES) {
      this._killChild();
      this.status = 'idle';
      this.frozenSec = 0;
      this.playingSince = null;
      this.ipcPos = null;
      this.hint = '连续多首播放失败，已停止（检查文件是否损坏）';
      this._stopTimer();
      this._emit();
      this._persist();
      return;
    }
    if (errorHint !== null) this.hint = errorHint;
    if (this.loopMode === 'one' && errorHint === null) {
      const current = this.trackById(this.currentId);
      if (current !== null) {
        this._start(current, 0);
        return;
      }
    }
    // 列表循环 / 顺序播放：交给 next 的自动分支。
    if (!this.next(true)) {
      this.status = 'idle';
      this.frozenSec = 0;
      this.ipcPos = null;
      this._stopTimer();
      this._emit();
    }
  }

  _killChild() {
    if (this.backend === 'mpv') {
      // 常驻进程不杀：stop 回 idle，下一首 loadfile 无缝接上。
      this._mpvLoadedId = null;
      this.ipcPos = null;
      if (this._mpv !== null && this._mpv.socket !== null) {
        void this._mpv.command(['stop']).catch(() => {});
      }
      this._stopTimer();
      return;
    }
    if (this.child !== null) {
      const child = this.child;
      // 先置空再杀：exit 事件晚到时会因身份不等被丢弃。
      this.child = null;
      try {
        child.kill('SIGKILL');
      } catch {
        // 已退出。
      }
    }
    this._stopTimer();
  }

  _startTimer() {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this._emit();
      // mpv 播放中轮询精确进度（一次本地 socket 往返，开销可忽略）。
      if (this.backend === 'mpv' && this.status === 'playing' && this._mpv !== null && this._mpvLoadedId !== null) {
        const ipc = this._mpv;
        void ipc
          .command(['get_property', 'time-pos'])
          .then((pos) => {
            if (typeof pos === 'number' && this._mpv === ipc) {
              this.ipcPos = { pos, at: Date.now() };
              this._emit();
            }
          })
          .catch(() => {});
      }
    }, TICK_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  _stopTimer() {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  _emit() {
    this.emit('change');
  }

  _persist() {
    if (typeof this.onPersist === 'function') {
      try {
        this.onPersist();
      } catch {
        // 持久化失败不影响播放。
      }
    }
  }
}
