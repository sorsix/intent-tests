// The develop session's view of the page for Launcher (docs/develop-mode.md, section 3.1): JPEG frames from CDP's
// Page.startScreencast, each acknowledged once it has been handed on, and the person's mouse and keyboard replayed with
// CDP's Input domain. Chromium only, like the engine. Coordinates are viewport CSS pixels.
import type { CDPSession, Page } from '@playwright/test';
import type { InputEvent } from './protocol.ts';

export type Frame = {
  /** Base64 JPEG. */
  data: string;
  /** The JPEG's size in pixels. */
  width: number;
  height: number;
  /** The page's viewport in CSS pixels, which input coordinates refer to. */
  viewport: { width: number; height: number };
  url: string;
};

export type ScreencastOptions = { maxWidth: number; quality: number };

type ScreencastFrameEvent = {
  data: string;
  sessionId: number;
  metadata: { deviceWidth: number; deviceHeight: number };
};

/** Width and height from a JPEG's start-of-frame marker, or null when the bytes are not a JPEG. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return {
        height: (bytes[at + 5] << 8) | bytes[at + 6],
        width: (bytes[at + 7] << 8) | bytes[at + 8],
      };
    at += 2 + ((bytes[at + 2] << 8) | bytes[at + 3]);
  }
  return null;
}

/** The frame size, read from the JPEG header (usually in its first kilobytes). */
function frameSize(data: string): { width: number; height: number } | null {
  return (
    jpegSize(Buffer.from(data.slice(0, 8192), 'base64')) ?? jpegSize(Buffer.from(data, 'base64'))
  );
}

const MOUSE_TYPES = ['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel'];
const BUTTONS = ['left', 'middle', 'right', 'none'];
const KEY_TYPES = ['keyDown', 'keyUp', 'char'];

/** Why an input event cannot be dispatched, or null when it can. */
export function inputProblem(event: unknown): string | null {
  const e = event as Record<string, unknown> | null;
  if (!e || typeof e !== 'object') return 'event must be an object';
  const finite = (key: string, optional = true) =>
    e[key] === undefined ? optional : typeof e[key] === 'number' && Number.isFinite(e[key]);
  const text = (key: string, optional = true) =>
    e[key] === undefined ? optional : typeof e[key] === 'string';
  if (e.kind === 'mouse') {
    if (!MOUSE_TYPES.includes(e.type as string))
      return `mouse type must be one of ${MOUSE_TYPES.join(', ')}`;
    if (!finite('x', false) || !finite('y', false)) return 'mouse x and y must be numbers';
    if (e.button !== undefined && !BUTTONS.includes(e.button as string))
      return `button must be one of ${BUTTONS.join(', ')}`;
    if (!finite('clickCount') || !finite('deltaX') || !finite('deltaY') || !finite('modifiers'))
      return 'clickCount, deltaX, deltaY and modifiers must be numbers';
    return null;
  }
  if (e.kind === 'key') {
    if (!KEY_TYPES.includes(e.type as string))
      return `key type must be one of ${KEY_TYPES.join(', ')}`;
    if (!text('key', false) || !text('code', false) || !text('text'))
      return 'key and code must be strings (text too, when given)';
    if (!finite('modifiers') || !finite('windowsVirtualKeyCode'))
      return 'modifiers and windowsVirtualKeyCode must be numbers';
    return null;
  }
  if (e.kind === 'insertText') return text('text', false) ? null : 'text must be a string';
  return 'kind must be mouse, key or insertText';
}

/** One page's CDP channel: the screencast and input replay. */
export class PageView {
  readonly page: Page;
  private cdp: Promise<CDPSession> | null = null;
  private casting = false;
  private readonly onFrame: (frame: Frame) => Promise<void>;

  /** `onFrame` resolves when the frame has been handed on; only then is it acknowledged (CDP sends the next one). */
  constructor(page: Page, onFrame: (frame: Frame) => Promise<void>) {
    this.page = page;
    this.onFrame = onFrame;
  }

  private session(): Promise<CDPSession> {
    this.cdp ??= this.page
      .context()
      .newCDPSession(this.page)
      .then((cdp) => {
        cdp.on('Page.screencastFrame', (event: ScreencastFrameEvent) => {
          const ack = () =>
            void cdp
              .send('Page.screencastFrameAck', { sessionId: event.sessionId })
              .catch(() => undefined);
          if (!this.casting) return ack();
          const viewport = {
            width: Math.round(event.metadata.deviceWidth),
            height: Math.round(event.metadata.deviceHeight),
          };
          this.onFrame({
            data: event.data,
            ...(frameSize(event.data) ?? viewport),
            viewport,
            url: this.page.url(),
          }).then(ack, ack);
        });
        return cdp;
      });
    return this.cdp;
  }

  /** Starts (or restarts with new options) the screencast. */
  async startScreencast({ maxWidth, quality }: ScreencastOptions): Promise<void> {
    const cdp = await this.session();
    if (this.casting) await cdp.send('Page.stopScreencast').catch(() => undefined);
    const viewport = this.page.viewportSize();
    const maxHeight = viewport
      ? Math.max(1, Math.round((maxWidth * viewport.height) / viewport.width))
      : maxWidth;
    this.casting = true;
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality, maxWidth, maxHeight });
  }

  async stopScreencast(): Promise<void> {
    if (!this.casting) return;
    this.casting = false;
    const cdp = await this.session();
    await cdp.send('Page.stopScreencast').catch(() => undefined);
  }

  get screencasting(): boolean {
    return this.casting;
  }

  /** Replays one input event into the page. */
  async input(event: InputEvent): Promise<void> {
    const cdp = await this.session();
    if (event.kind === 'mouse') {
      await cdp.send('Input.dispatchMouseEvent', {
        type: event.type,
        x: event.x,
        y: event.y,
        button: event.button ?? (event.type === 'mouseMoved' ? 'none' : 'left'),
        clickCount:
          event.clickCount ??
          (event.type === 'mousePressed' || event.type === 'mouseReleased' ? 1 : 0),
        modifiers: event.modifiers ?? 0,
        ...(event.type === 'mouseWheel'
          ? { deltaX: event.deltaX ?? 0, deltaY: event.deltaY ?? 0 }
          : {}),
      });
    } else if (event.kind === 'key') {
      await cdp.send('Input.dispatchKeyEvent', {
        type: event.type,
        key: event.key,
        code: event.code,
        modifiers: event.modifiers ?? 0,
        ...(event.text !== undefined ? { text: event.text } : {}),
        ...(event.windowsVirtualKeyCode !== undefined
          ? {
              windowsVirtualKeyCode: event.windowsVirtualKeyCode,
              nativeVirtualKeyCode: event.windowsVirtualKeyCode,
            }
          : {}),
      });
    } else {
      await cdp.send('Input.insertText', { text: event.text });
    }
  }

  /** Stops the screencast and detaches from the page. */
  async close(): Promise<void> {
    this.casting = false;
    const cdp = this.cdp;
    this.cdp = null;
    if (cdp) await cdp.then((session) => session.detach()).catch(() => undefined);
  }
}
