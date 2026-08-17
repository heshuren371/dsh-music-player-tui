import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { accessSync, constants } from 'node:fs';

/**
 * 播放后端探测：ffplay 优先（全格式 + -ss 快进快退 + -volume），
 * afplay 兜底（macOS 自带；无 seek，音量在下次起播时生效）。
 * mpv（JSON IPC 全功能）留作后续后端，探测链就位即可加入。
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
/** seek 低于这个量不值得重启解码进程。 */
const MIN_SEEK_RESPAWN_OFFSET = 0.3;

export class PlayerEngine extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(20);
    /** @type {'ffplay' | 'afplay' | null} */
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
    this.frozenSec = 0; // 暂停/起播基准偏移
    this.playingSince = null; // status==='playing' 时的起播墙钟
    this.timer = null;
    /** 宿主（index.js）挂的持久化回调，在关键时刻调用（不含 tick）。 */
    this.onPersist = null;
  }

  async _detect() {
    this.backend = await detectBackend();
    this.backendChecked = true;
    if (this.backend === null) {
      this.hint = '未找到播放器：请安装 ffmpeg（brew install ffmpeg）以获得 ffplay';
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
    if (this.status === 'playing' && this.playingSince !== null) {
      const track = this.trackById(this.currentId);
      const elapsed = this.frozenSec + (Date.now() - this.playingSince) / 1000;
      // 时长已知则钳住显示，自然结束事件马上会接力推进。
      if (track?.duration != null) return Math.min(elapsed, track.duration);
      return elapsed;
    }
    return this.status === 'idle' ? 0 : this.frozenSec;
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
      this.hint = '未找到播放器：请安装 ffmpeg（brew install ffmpeg）以获得 ffplay';
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
    if (process.platform === 'win32') {
      this.hint = 'Windows 暂不支持暂停（无 SIGSTOP）';
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
    this._emit();
    this._persist();
  }

  /**
   * 以暂停态把曲目 cue 在指定位置（不开声）：用于重启后恢复上次播放。
   * resume/play 会从 frozenSec 重新起播（child 为 null 的分支）。
   */
  cue(id, positionSec = 0) {
    if (this.trackById(id) === null) return false;
    this._killChild();
    this.currentId = id;
    this.status = 'paused';
    this.frozenSec = positionSec > 0 ? positionSec : 0;
    this.playingSince = null;
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

  /** 相对 seek（秒）。ffplay 重启解码到目标位置；afplay 不支持。 */
  seek(deltaSec) {
    const track = this.trackById(this.currentId);
    if (track === null || this.status === 'idle') return false;
    if (this.backend !== 'ffplay') {
      this.hint = `当前后端（${this.backend ?? '无'}）不支持快进快退，安装 ffmpeg 即可`;
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
    if (this.status === 'playing') {
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

  dispose() {
    this.disposed = true;
    this._killChild();
    this._stopTimer();
    this.removeAllListeners();
  }

  // ── 内部 ─────────────────────────────────────────────────────────────

  _start(track, offsetSec) {
    this._killChild();
    this.hint = null;
    const args =
      this.backend === 'ffplay'
        ? [
            '-nodisp',
            '-autoexit',
            '-loglevel',
            'error',
            '-volume',
            String(this.volume),
            ...(offsetSec > MIN_SEEK_RESPAWN_OFFSET ? ['-ss', offsetSec.toFixed(1)] : []),
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
    child.once('exit', (code, signal) => {
      if (child !== this.child || this.disposed) return;
      this.child = null;
      this.playingSince = null;
      if (typeof code === 'number' && code !== 0) {
        this.hint = `播放器退出码 ${code}：${track.name}`;
      }
      if (this.loopMode === 'one') {
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
        this._stopTimer();
        this._emit();
      }
    });
    this._startTimer();
    this._emit();
    this._persist();
  }

  _killChild() {
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
    this.timer = setInterval(() => this._emit(), TICK_MS);
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
