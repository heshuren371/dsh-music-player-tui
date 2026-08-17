# dsh-music-player-tui

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) TUI 界面（[dsh-tui](https://github.com/ccch1mneyyy/dsh-TUI)）的本地音乐播放器插件。输入 `/music` 打开全屏「音乐」场景（与 `/trace` 轨迹场景同款机制），在终端里边聊边听歌。

A local music player plugin for the dsh-tui terminal front door — `/music` opens a full-screen scene (same machinery as the `/trace` trajectory scene) so you can listen while you chat.

## 功能 / Features

- 📁 本地目录递归扫描：**flac / mp3 / m4a / aac / ogg / opus / wav**，内嵌标签解析（缺省回退「歌手 - 歌名」文件名约定）
- 🎵 曲目列表：歌名、歌手、时长；↑/↓ 或 j/k 选择，窗口随终端高度自适应
- 🔀 排序：歌名 / 歌手 / 时长，升降序切换；**播放顺序 = 可见列表顺序**（排序/搜索后，「下一首」就是你看到的下一行）
- 🔍 搜索过滤：歌名 / 歌手 / 文件名
- 🔁 循环模式：列表循环 / 单曲循环 / 播完即停
- ⏩ 快进快退：←/→ ±5s（Shift ±30s）；音量 +/- 调整（每次 5%）
- ⏯️ **退出场景音乐不中断**：播放进程由宿主 spawn，关掉场景照样唱，随时 `/music` 回来
- 💾 状态持久化：目录 / 音量 / 循环模式 / 最后播放曲目与进度（`lib/state.json`），重启后曲目以暂停态 cue 在原位置
- 🎛️ `/music` 子命令直达：`dir` / `play [关键词]` / `pause` / `next` / `prev` / `vol` / `refresh`，不进场景也能操控
- 🧩 标准 bundle 插件：零核心改动，进插件清单，卸载即净

## 播放后端 / Playback backends

TUI 没有浏览器，播放靠宿主本机的播放器进程（自动探测，先到先得）：

| 后端 | 说明 |
| --- | --- |
| `ffplay`（ffmpeg） | **推荐**。全格式、快进快退（`-ss`）、即时音量。`brew install ffmpeg` / `apt install ffmpeg` |
| `afplay`（macOS 自带） | 兜底。不能快进快退，音量在下次起播时生效 |

两个都没有时插件照常挂载，起播会提示安装 ffmpeg。暂停/继续依赖 POSIX 信号（SIGSTOP/SIGCONT），Windows 暂不支持暂停。

> 路线图上还有 `mpv`（JSON IPC：精确进度、无接缝音量/seek）——探测链已就位，后续版本加入。

## 快速安装 / Quick Install

前置条件：已安装并能运行 `dsh-tui`（≥ 0.8，首次运行会自动初始化 profile）。

```bash
dsh plugin --profile dsh-tui add github:heshuren371/dsh-music-player-tui
```

重启 `dsh-tui`，输入 `/music` 回车——全屏场景出现即成功。想锁定版本：`github:heshuren371/dsh-music-player-tui#v0.1.0`。

## 键位 / Keys（场景内）

| 键 | 功能 |
| --- | --- |
| `Enter` | 播放选中曲目 |
| `Space` | 暂停 / 继续 |
| `↑`/`↓` 或 `k`/`j` | 移动选择（`PageUp/PageDown` 翻页，`Home/End` 首尾） |
| `n` / `p` | 下一首 / 上一首 |
| `←` / `→` | 快退 / 快进 5s（Shift = 30s，仅 ffplay） |
| `+` / `-` | 音量 ±5% |
| `s` / `r` | 切换排序字段（歌名→歌手→时长）/ 切换升降序 |
| `l` | 循环模式（列表 → 单曲 → 播完即停） |
| `/` | 搜索（Enter 确认，Esc 取消） |
| `u` | 设置音乐目录（粘贴路径，Enter 确认；支持 `~`） |
| `R` | 重新扫描当前目录 |
| `q` / `Esc` | 退出场景（**音乐继续播放**） |

## `/music` 子命令

```
/music                  打开全屏音乐场景
/music dir <路径>        设置目录并扫描（如 /music dir ~/Music）
/music play [关键词]     播放当前/第一首；带关键词播首个匹配曲目
/music pause            暂停 / 继续
/music next | prev      切歌
/music vol <0-100>      音量
/music refresh          重新扫描
```

## 卸载 / Uninstall

```bash
dsh plugin --profile dsh-tui remove @local/dsh-music-player-tui
```

重启 `dsh-tui` 即彻底移除（装配层自动清理，播放进程随之退出）。插件只读你的音乐文件，卸载不动任何音频。

## 结构 / Structure

```
lib/index.js   cordis 入口：/music 命令 + 场景注册 + 扫描调度 + state.json 持久化
lib/player.js  播放引擎：ffplay/afplay 探测、spawn 控制、信号暂停、循环接力、进度推算
lib/scanner.js 目录扫描 + music-metadata 标签解析（与 web 版同一套逻辑）
lib/scene.js   全屏场景：宿主 React/ui 渲染（契约要求，无 JSX、无自带 React）
```

与 Web 版 [dsh-music-player](https://github.com/heshuren371/dsh-music-player) 的关系：扫描/标签解析逻辑共享，播放引擎重写（浏览器 `<audio>` + Range 流 → 本机播放器进程），UI 按 dsh-tui scenes 契约全新实现。

## License

[MIT](./LICENSE)
