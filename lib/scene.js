/**
 * 音乐场景：全屏曲目列表 + 底部播放条。
 *
 * 严格遵守 dsh-tui 的场景契约：所有 hook 与元素创建都走 props 注入的宿主
 * React 与 ui kit，绝不引入插件自己的 React 副本（双 React 会在第一次
 * hook 调用时炸掉）。因此本文件不使用 JSX——避免编译到插件侧运行时，
 * 一律 React.createElement。
 */

const SORT_KEYS = ['title', 'artist', 'duration'];
const SORT_LABELS = { title: '歌名', artist: '歌手', duration: '时长' };
const LOOP_LABELS = { list: '🔁 列表循环', one: '🔂 单曲循环', off: '⏹ 播完即停' };

// ── 终端宽度工具（CJK/emoji 按 2 列计） ────────────────────────────────

function charWidth(code) {
  return code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      (code >= 0x20000 && code <= 0x3fffd))
    ? 2
    : 1;
}

function displayWidth(text) {
  let width = 0;
  for (const char of text) width += charWidth(char.codePointAt(0));
  return width;
}

function truncate(text, maxWidth) {
  if (displayWidth(text) <= maxWidth) return text;
  let out = '';
  let width = 0;
  for (const char of text) {
    const w = charWidth(char.codePointAt(0));
    if (width + w > maxWidth - 1) break;
    out += char;
    width += w;
  }
  return out + '…';
}

function padEnd(text, width) {
  const gap = width - displayWidth(text);
  return gap > 0 ? text + ' '.repeat(gap) : text;
}

function padStart(text, width) {
  const gap = width - displayWidth(text);
  return gap > 0 ? ' '.repeat(gap) + text : text;
}

function formatTime(sec) {
  if (sec == null || !Number.isFinite(sec)) return '--:--';
  const total = Math.max(0, Math.floor(sec));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const hours = Math.floor(minutes / 60);
  return hours > 0
    ? `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function progressBar(position, duration, width) {
  if (width <= 0) return '';
  if (duration == null || duration <= 0) return '░'.repeat(width);
  const ratio = Math.max(0, Math.min(1, position / duration));
  const filled = Math.round(ratio * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

function compareTracks(key) {
  const byTitle = (a, b) =>
    a.title.localeCompare(b.title, 'zh-Hans-CN', { numeric: true }) ||
    a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true });
  if (key === 'duration') {
    return (a, b) => (a.duration ?? Number.MAX_SAFE_INTEGER) - (b.duration ?? Number.MAX_SAFE_INTEGER) || byTitle(a, b);
  }
  if (key === 'artist') {
    return (a, b) =>
      (a.artist ?? '￿').localeCompare(b.artist ?? '￿', 'zh-Hans-CN', { numeric: true }) || byTitle(a, b);
  }
  return byTitle;
}

/**
 * @param {import('./player.js').PlayerEngine} engine 播放引擎（宿主侧单例）
 * @param {{ setDir(dir: string): Promise<void>, refresh(): Promise<void>, deleteTrack(id: string): Promise<object> }} controller
 *   场景触发的宿主动作：换目录并扫描 / 重新扫描当前目录 / 删除曲目（含本地文件）。
 */
export function createMusicScene(engine, controller) {
  return function MusicScene({ React, ui, close }) {
    const { Box, Text, useInput, useTerminalSize } = ui;
    const e = React.createElement;

    const [, forceRender] = React.useState(0);
    React.useEffect(() => {
      const rerender = () => forceRender((n) => n + 1);
      engine.on('change', rerender);
      return () => {
        engine.off('change', rerender);
      };
    }, []);

    const [selected, setSelected] = React.useState(0);
    const [sortIndex, setSortIndex] = React.useState(0);
    const [sortAsc, setSortAsc] = React.useState(true);
    const [filter, setFilter] = React.useState('');
    /** @type {'normal' | 'search' | 'dir'} */
    const [mode, setMode] = React.useState('normal');
    const [buffer, setBuffer] = React.useState('');
    const [notice, setNotice] = React.useState(null);
    /** 删除二次确认：第一下 x 记下曲目 id，第二下 x 才真删。 */
    const [pendingDelete, setPendingDelete] = React.useState(null);

    const state = engine.getState();
    const tracks = state.library?.tracks ?? [];
    const sortKey = SORT_KEYS[sortIndex];

    const lowered = filter.trim().toLowerCase();
    const filtered =
      lowered.length === 0
        ? tracks
        : tracks.filter(
            (track) =>
              track.title.toLowerCase().includes(lowered) ||
              (track.artist ?? '').toLowerCase().includes(lowered) ||
              track.name.toLowerCase().includes(lowered),
          );
    const base = compareTracks(sortKey);
    const sorted = filtered.slice().sort((a, b) => (sortAsc ? base(a, b) : base(b, a)));
    const sortedIdsKey = sorted.map((track) => track.id).join('\n');

    // 播放顺序 = 可见列表顺序：排序/搜索后的「下一首」就是屏幕上看到的下一行。
    React.useEffect(() => {
      engine.setOrder(sortedIdsKey.length === 0 ? [] : sortedIdsKey.split('\n'));
    }, [sortedIdsKey]);

    const sel = Math.max(0, Math.min(selected, sorted.length - 1));

    function commitInput() {
      const value = buffer.trim();
      if (mode === 'search') {
        setFilter(value);
        setSelected(0);
        setMode('normal');
        setBuffer('');
        setNotice(null);
        return;
      }
      if (mode === 'dir') {
        if (value.length === 0) {
          setMode('normal');
          setBuffer('');
          return;
        }
        controller.setDir(value).then(
          () => {
            setMode('normal');
            setBuffer('');
            setNotice(null);
            setFilter('');
            setSelected(0);
          },
          (error) => {
            setNotice(error instanceof Error ? error.message : String(error));
          },
        );
      }
    }

    useInput((input, key) => {
      // ── 文本输入模式（搜索 / 目录路径） ──
      if (mode !== 'normal') {
        if (key.return) {
          commitInput();
          return;
        }
        if (key.escape) {
          setMode('normal');
          setBuffer('');
          setNotice(null);
          return;
        }
        if (key.backspace || key.delete) {
          setBuffer((current) => current.slice(0, -1));
          return;
        }
        if (input && !key.ctrl && !key.meta) {
          // 粘贴整段到达：路径里允许空格，只剔除换行。
          setBuffer((current) => current + input.replace(/[\r\n]+/g, ''));
        }
        return;
      }

      // ── 普通模式 ──
      if (key.ctrl || key.meta) return; // 组合键留给 TUI 自己

      // 删除二次确认中：第二下 x 执行；Esc 仅取消删除（不退出场景）；其他键取消后继续原逻辑。
      if (pendingDelete !== null) {
        if (input === 'x') {
          const id = pendingDelete;
          setPendingDelete(null);
          void controller.deleteTrack(id).then(
            (track) => setNotice(`已删除：${track.title}${track.artist ? ' — ' + track.artist : ''}`),
            (error) => setNotice(error instanceof Error ? error.message : String(error)),
          );
          return;
        }
        setPendingDelete(null);
        if (key.escape) return;
      }
      // 上一次的操作反馈（删除成功/失败等）在任意按键后清掉。
      if (notice !== null && mode === 'normal') setNotice(null);

      if (key.escape || input === 'q') {
        close();
        return;
      }
      if (key.upArrow || input === 'k') {
        setSelected((current) => Math.max(0, current - 1));
        return;
      }
      if (key.downArrow || input === 'j') {
        setSelected((current) => Math.min(sorted.length - 1, current + 1));
        return;
      }
      if (key.pageUp) {
        setSelected((current) => Math.max(0, current - 10));
        return;
      }
      if (key.pageDown) {
        setSelected((current) => Math.min(sorted.length - 1, current + 10));
        return;
      }
      if (key.home) {
        setSelected(0);
        return;
      }
      if (key.end) {
        setSelected(Math.max(0, sorted.length - 1));
        return;
      }
      if (key.return) {
        const track = sorted[sel];
        if (track !== undefined) void engine.play(track.id);
        return;
      }
      if (input === ' ') {
        void engine.toggle();
        return;
      }
      if (input === 'n') {
        void engine.next();
        return;
      }
      if (input === 'p') {
        void engine.prev();
        return;
      }
      if (key.leftArrow) {
        engine.seek(key.shift ? -30 : -5);
        return;
      }
      if (key.rightArrow) {
        engine.seek(key.shift ? 30 : 5);
        return;
      }
      if (input === 's') {
        setSortIndex((current) => (current + 1) % SORT_KEYS.length);
        return;
      }
      if (input === 'r') {
        setSortAsc((current) => !current);
        return;
      }
      if (input === 'R') {
        void controller.refresh();
        return;
      }
      if (input === 'l') {
        engine.cycleLoopMode();
        return;
      }
      if (input === '+' || input === '=') {
        engine.setVolume(state.volume + 5);
        return;
      }
      if (input === '-' || input === '_') {
        engine.setVolume(state.volume - 5);
        return;
      }
      if (input === '/') {
        setMode('search');
        setBuffer('');
        setNotice(null);
        return;
      }
      if (input === 'u') {
        setMode('dir');
        setBuffer(state.library?.dir ?? '');
        setNotice(null);
        return;
      }
      if (input === 'x') {
        const track = sorted[sel];
        if (track !== undefined) setPendingDelete(track.id);
        return;
      }
    });

    // ── 布局 ──
    const { columns, rows } = useTerminalSize();
    const width = Math.max(40, columns);
    const CHROME_ROWS = 5; // 标题 + 状态行 + 播放行 + 进度行 + 帮助行
    const listHeight = Math.max(3, rows - CHROME_ROWS);
    const windowStart = Math.max(0, Math.min(sel - (listHeight >> 1), Math.max(0, sorted.length - listHeight)));
    const visible = sorted.slice(windowStart, windowStart + listHeight);

    // 标题行
    const dirLabel = state.library?.dir ?? '未设置目录';
    const countLabel = `${tracks.length} 首`;
    const filterLabel = filter.length > 0 ? ` · 搜索“${filter}” ${sorted.length}/${tracks.length}` : '';
    const truncatedLabel = state.library?.truncated === true ? ' · 已达 5000 上限（截断）' : '';
    const sortLabel = ` · 排序:${SORT_LABELS[sortKey]}${sortAsc ? '↑' : '↓'}`;
    const header = truncate(`🎵 音乐  ${dirLabel} · ${countLabel}${filterLabel}${truncatedLabel}${sortLabel}`, width);

    // 状态行（扫描进度 / 错误 / 后端提示，单行轮换）
    let statusText = '';
    let statusColor = 'subtle';
    if (state.scanError !== null) {
      statusText = `扫描失败：${state.scanError}`;
      statusColor = 'error';
    } else if (state.hint !== null) {
      statusText = state.hint;
      statusColor = 'warning';
    } else if (state.scanning !== null) {
      statusText = `正在扫描… ${state.scanning.parsed}/${state.scanning.total}`;
      statusColor = 'subtle';
    }

    // 列表区
    let listChildren;
    if (state.library === null && state.scanning === null) {
      listChildren = [
        e(Text, { key: 'empty', color: 'subtle' }, '按 u 输入音乐目录路径（如 ~/Music 或 D:\\Music），或在对话里 /music dir <路径>'),
      ];
    } else if (sorted.length === 0 && state.scanning === null) {
      const message =
        tracks.length === 0
          ? '目录中没有音频文件（支持 mp3 / flac / m4a / aac / ogg / opus / wav）'
          : `没有匹配“${filter}”的曲目（按 / 修改搜索，Esc 退出）`;
      listChildren = [e(Text, { key: 'empty', color: 'subtle' }, message)];
    } else {
      listChildren = visible.map((track, offset) => {
        const index = windowStart + offset;
        const isSelected = index === sel;
        const isCurrent = track.id === state.currentId;
        const prefix = isSelected ? '▸' : isCurrent ? (state.status === 'paused' ? '‖' : '▶') : ' ';
        const indexLabel = padStart(String(index + 1), 3);
        const timeLabel = padStart(formatTime(track.duration), 6);
        const nameWidth = Math.max(8, width - 2 - 5 - 7);
        const name = truncate(`${track.title}${track.artist ? ' — ' + track.artist : ''}`, nameWidth);
        const line = `${prefix} ${indexLabel}. ${padEnd(name, nameWidth)} ${timeLabel}`;
        const props = isSelected
          ? { inverse: true, bold: true }
          : isCurrent
            ? { color: 'success', bold: true }
            : { color: 'text' };
        // 每行包一层 Box 挂鼠标事件（宿主 AlternateScreen 已开 SGR 鼠标追踪）：
        // 悬停移动选择光标，点击直接播放；点到行尾未渲染的空白格不触发。
        return e(
          Box,
          {
            key: track.id,
            onMouseEnter: () => {
              if (mode === 'normal' && index !== sel) setSelected(index);
            },
            onClick: (event) => {
              if (event.cellIsBlank || mode !== 'normal') return;
              // 与键盘一致：任何其他操作先取消删除二次确认、清掉上一条反馈。
              if (pendingDelete !== null) setPendingDelete(null);
              if (notice !== null) setNotice(null);
              setSelected(index);
              void engine.play(track.id);
            },
          },
          e(Text, { ...props }, line),
        );
      });
    }

    // 播放行
    const track = state.track;
    const statusIcon = state.status === 'playing' ? '▶' : state.status === 'paused' ? '⏸' : '⏹';
    const nowLine =
      track !== null
        ? truncate(`${statusIcon}  ${track.title}${track.artist ? ' — ' + track.artist : ''}`, width)
        : state.library === null
          ? '先选目录，再 enter 播放'
          : 'enter 播放选中曲目';

    // 进度行
    const loopLabel = LOOP_LABELS[state.loopMode] ?? state.loopMode;
    const volumeLabel = `🔊 ${state.volume}%`;
    const backendLabel = state.backend ?? (state.backendChecked ? '无播放器' : '检测中…');
    const timeLabel = `${formatTime(state.position)} / ${formatTime(state.duration)}`;
    const rightPart = ` ${timeLabel}  ${loopLabel}  ${volumeLabel}  ${backendLabel}`;
    const barWidth = Math.max(8, width - displayWidth(rightPart) - 1);
    const progressLine = `${progressBar(state.position, state.duration, barWidth)}${rightPart}`;

    // 帮助 / 输入行
    let bottomLine;
    if (mode === 'search') {
      bottomLine = e(Text, { key: 'input', color: 'suggestion' }, truncate(`搜索: ${buffer}█`, width));
    } else if (mode === 'dir') {
      bottomLine = e(
        Text,
        { key: 'input', color: notice !== null ? 'error' : 'suggestion' },
        truncate(notice !== null ? `目录: ${buffer}█  ${notice}` : `目录: ${buffer}█`, width),
      );
    } else if (pendingDelete !== null) {
      const target = engine.trackById(pendingDelete);
      bottomLine = e(
        Text,
        { key: 'delete', color: 'error' },
        truncate(`再按 x 确认删除《${target?.title ?? pendingDelete}》——本地文件将被移除，不可恢复（Esc / 其他键取消）`, width),
      );
    } else if (notice !== null) {
      bottomLine = e(Text, { key: 'notice', color: 'subtle' }, truncate(notice, width));
    } else {
      bottomLine = e(
        Text,
        { key: 'help', color: 'subtle' },
        truncate('鼠标点击播放 · enter 播放 · space 暂停 · j/k 选择 · n/p 切歌 · s 排序 · l 循环 · / 搜索 · u 目录 · x 删除 · q/Esc 退出', width),
      );
    }

    return e(
      Box,
      { flexDirection: 'column' },
      e(Text, { bold: true }, header),
      e(Text, { color: statusColor }, truncate(statusText, width)),
      e(Box, { flexDirection: 'column', height: listHeight }, ...listChildren),
      e(Text, { color: track !== null ? 'text' : 'subtle', bold: track !== null }, nowLine),
      e(Text, { color: 'subtle' }, progressLine),
      bottomLine,
    );
  };
}
