// src/dashboard/host-terminal-replay.ts
//
// 宿主终端「重连 / 切回前台」时的重同步材料，刻意不在服务端跑终端仿真器：
// 那等于把每个输出字节在 dashboard 事件循环里再解析一遍（@xterm/headless 实测
// 几十 MB/s，`cat` 大文件时会把整个 dashboard 拖住）。这里只保留两样廉价状态：
//
//  - OutputRing：最近 N 字节原始输出，按块存、超容整块丢，重放给新连上的浏览器；
//  - TerminalModeTracker：用 Buffer.indexOf 扫 ESC，只认少数几个影响「输入怎么编码 /
//    画在哪块屏上」的 DEC 私有模式（备用屏、鼠标上报、括号粘贴、应用光标键…）。
//    环形缓冲头部被截掉后，重放内容里可能缺了打开这些模式的那条序列；重放完把它们
//    按真实状态补发一遍，TUI 的鼠标/粘贴才不会在刷新页面后失灵。

/** 跟踪的 DEC 私有模式（`CSI ? Pm h/l`）。 */
const TRACKED_MODES = [
  1, // DECCKM 应用光标键
  25, // DECTCEM 光标可见
  1000, 1002, 1003, // 鼠标上报
  1004, // 焦点事件
  1005, 1006, 1015, // 鼠标编码
  2004, // 括号粘贴
] as const;
const ALT_SCREEN_MODES = new Set([47, 1047, 1049]);
const TRACKED = new Set<number>(TRACKED_MODES);
const DEFAULT_ON = new Set<number>([25]);

const ESC = 0x1b;
/** 跨块截断的转义序列最多续这么长；更长的不可能是我们关心的模式序列。 */
const MAX_SEQ = 64;

export class TerminalModeTracker {
  private modes = new Map<number, boolean>();
  private alt: boolean;
  private keypad = false;
  private carry: Buffer | null = null;

  /** startAlt：从「已在备用屏」开始跟踪（算环形缓冲某个切口处的屏幕状态用）。 */
  constructor(startAlt = false) {
    this.alt = startAlt;
  }

  get altScreen(): boolean { return this.alt; }

  isOn(mode: number): boolean {
    return this.modes.get(mode) ?? DEFAULT_ON.has(mode);
  }

  feed(chunk: Buffer): void {
    let start = 0;
    if (this.carry) {
      const carry = this.carry;
      this.carry = null;
      const head = Buffer.concat([carry, chunk.subarray(0, MAX_SEQ)]);
      const end = this.parseAt(head, 0);
      if (end < 0) {
        if (head.length < MAX_SEQ && head.length === carry.length + chunk.length) this.carry = head;
        return;
      }
      start = Math.max(0, end - carry.length);
    }
    let i = chunk.indexOf(ESC, start);
    while (i !== -1) {
      const end = this.parseAt(chunk, i);
      if (end < 0) {
        if (chunk.length - i < MAX_SEQ) this.carry = Buffer.from(chunk.subarray(i));
        return;
      }
      i = chunk.indexOf(ESC, end);
    }
  }

  /**
   * 把模式恢复到真实状态的序列，接在重放内容之后发，其余模式开的发 h、关的发 l。
   *
   * 备用屏只在「应该在备用屏」时补一条 DECSET 1047：重放内容的最后一次切屏与真实状态
   * 一致，唯一可能对不上的是「切进备用屏那条已被环形缓冲截掉」。不用 1049：它的 set
   * 会先 DECSC 覆盖已保存的光标，reset 则无论在哪块屏都会 DECRC——普通屏下补一条
   * `?1049l` 会把光标拽回保存点（RIS 之后就是左上角），后续输出盖掉提示符。
   */
  restoreSequence(): string {
    let out = this.alt ? '\x1b[?1047h' : '';
    const on: number[] = [];
    const off: number[] = [];
    for (const m of TRACKED_MODES) (this.isOn(m) ? on : off).push(m);
    if (off.length) out += `\x1b[?${off.join(';')}l`;
    if (on.length) out += `\x1b[?${on.join(';')}h`;
    out += this.keypad ? '\x1b=' : '\x1b>';
    return out;
  }

  /** 解析 buf[i] 处的 ESC 序列；返回其后的下标，序列不完整返回 -1。 */
  private parseAt(buf: Buffer, i: number): number {
    if (i + 1 >= buf.length) return -1;
    const b1 = buf[i + 1];
    if (b1 === 0x63) { // ESC c — RIS 全复位
      this.modes.clear();
      this.alt = false;
      this.keypad = false;
      return i + 2;
    }
    if (b1 === 0x3d) { this.keypad = true; return i + 2; } // ESC =
    if (b1 === 0x3e) { this.keypad = false; return i + 2; } // ESC >
    if (b1 !== 0x5b) return i + 1; // 不是 CSI
    if (i + 2 >= buf.length) return -1;
    if (buf[i + 2] !== 0x3f) return i + 2; // 不是 DEC 私有模式
    let j = i + 3;
    while (j < buf.length) {
      const b = buf[j];
      if (b >= 0x40 && b <= 0x7e) break; // final byte
      if (j - i > MAX_SEQ) return j;
      j++;
    }
    if (j >= buf.length) return -1;
    const final = buf[j];
    if (final === 0x68 || final === 0x6c) { // h / l
      const set = final === 0x68;
      for (const part of buf.toString('latin1', i + 3, j).split(';')) {
        const mode = Number(part);
        if (ALT_SCREEN_MODES.has(mode)) this.alt = set;
        else if (TRACKED.has(mode)) this.modes.set(mode, set);
      }
    }
    return j + 1;
  }
}

/** 小块合并阈值：交互回显是一两个字节一帧，不合并会攒出几万个小 Buffer。 */
const MERGE_BELOW = 16 * 1024;

/** 从 startAlt 出发吃完 bytes 之后是不是在备用屏。 */
function altAfter(bytes: Buffer, startAlt: boolean): boolean {
  const t = new TerminalModeTracker(startAlt);
  t.feed(bytes);
  return t.altScreen;
}

interface RingChunk {
  buf: Buffer;
  /** 这一块开头时终端是否在备用屏。 */
  alt: boolean;
}

export interface RingSnapshot {
  bytes: Buffer;
  /**
   * 快照开头时是否在备用屏。长时间运行的全屏程序（htop / vim）切进备用屏的那条
   * `?1049h` 早被挤出环形缓冲时，重放必须先切到备用屏再画，否则 TUI 内容会画进普通屏、
   * 污染滚动历史，而真正的备用屏一片空白。
   */
  altAtStart: boolean;
}

export class OutputRing {
  private chunks: RingChunk[] = [];
  private size = 0;
  private trimmed = false;

  constructor(private readonly capacity: number) {}

  get bytes(): number { return this.size; }

  /** altAtStart：frame 第一个字节之前终端是否在备用屏。 */
  push(frame: Buffer, altAtStart = false): void {
    if (frame.length === 0) return;
    const last = this.chunks[this.chunks.length - 1];
    if (last && last.buf.length < MERGE_BELOW && frame.length < MERGE_BELOW) {
      last.buf = Buffer.concat([last.buf, frame]);
    } else {
      // 独立拷贝：PTY 读出的 Buffer 可能是 64KB 读缓冲上的 subarray，直接留着会
      // 让每个几字节的回显钉住一整块读缓冲。
      this.chunks.push({ buf: Buffer.from(frame), alt: altAtStart });
    }
    this.size += frame.length;
    while (this.size > this.capacity && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.buf.length;
      this.trimmed = true;
    }
    if (this.size > this.capacity && this.chunks.length === 1) {
      const only = this.chunks[0];
      const cut = only.buf.length - this.capacity;
      only.alt = altAfter(only.buf.subarray(0, cut), only.alt);
      only.buf = Buffer.from(only.buf.subarray(cut));
      this.size = only.buf.length;
      this.trimmed = true;
    }
  }

  /**
   * 当前内容。头部被截过时从第一个换行之后开始——切口大概率落在一条转义序列中间，
   * 从行首起能少画一截乱码。
   */
  snapshot(): RingSnapshot {
    const head = this.chunks[0];
    if (!head) return { bytes: Buffer.alloc(0), altAtStart: false };
    const all = this.chunks.length === 1 ? head.buf : Buffer.concat(this.chunks.map(c => c.buf), this.size);
    if (!this.trimmed) return { bytes: all, altAtStart: head.alt };
    const nl = all.indexOf(0x0a);
    if (nl < 0 || nl >= 4096) return { bytes: all, altAtStart: head.alt };
    return { bytes: all.subarray(nl + 1), altAtStart: altAfter(all.subarray(0, nl + 1), head.alt) };
  }
}
