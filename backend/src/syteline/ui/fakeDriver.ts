/**
 * fakeDriver.ts — deterministic in-memory UiDriver for tests and CI.
 *
 * Models a tiny page graph: pages hold fields (by accessible label), buttons
 * (by accessible name, with scripted click handlers), and body text. All
 * behavior is synchronous and deterministic — no browser, no network.
 *
 * VALIDATED IN CI. The Playwright driver (playwrightDriver.ts) is the only
 * implementation that touches a real browser and REQUIRES REAL SYTELINE.
 */

import { Errors } from '../../errors.js';
import type { UiDriver } from './driver.js';

export interface FakePage {
  /** Body text returned by readScreen / searched by waitForText. */
  text: string;
  /** Fillable fields by accessible label. */
  fields: Record<string, string>;
  /** Buttons by accessible name; a handler runs on click and may navigate. */
  buttons: Record<string, (driver: FakeDriver) => void>;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw Errors.badRequest('TOOL_ABORTED', 'Tool call aborted');
}

export class FakeDriver implements UiDriver {
  private pages: Map<string, FakePage>;
  private currentUrl: string;
  private closed = false;
  /** Every fillField call, in order — lets tests assert what was typed. */
  readonly filledFields: Array<{ label: string; value: string }> = [];
  /** Every clickButton call, in order. */
  readonly clickedButtons: string[] = [];

  constructor(pages: Record<string, FakePage>, startUrl: string) {
    this.pages = new Map(Object.entries(pages));
    if (!this.pages.has(startUrl)) throw new Error(`FakeDriver: unknown start URL ${startUrl}`);
    this.currentUrl = startUrl;
  }

  /**
   * Build a fake SyteLine client: a login page at `baseUrl` plus a home
   * page. Clicking 'Log In' succeeds only when the typed credentials match
   * `validUsername`/`validPassword`, landing on the home page whose text
   * contains the 'Home' post-login marker loginSyteline waits for.
   */
  static withLoginPage(
    baseUrl: string,
    validUsername: string,
    validPassword: string,
    extraPages: Record<string, FakePage> = {},
  ): FakeDriver {
    const homeUrl = `${baseUrl}/home`;
    let typedUser = '';
    let typedPass = '';
    const loginPage: FakePage = {
      text: 'SyteLine Login',
      fields: { 'User Name': '', Password: '' },
      buttons: {
        'Log In': (driver) => {
          if (typedUser === validUsername && typedPass === validPassword) {
            driver.navigateTo(homeUrl);
          } else {
            driver.setPageText('SyteLine Login\nInvalid user name or password');
          }
        },
      },
    };
    const driver = new FakeDriver(
      {
        [baseUrl]: loginPage,
        [homeUrl]: {
          text: 'SyteLine Home\nWelcome',
          fields: {},
          buttons: {},
        },
        ...extraPages,
      },
      baseUrl,
    );
    // Capture what the test (via loginSyteline) types before the click.
    const originalFill = driver.fillField.bind(driver);
    driver.fillField = async (label: string, value: string, signal: AbortSignal) => {
      if (label === 'User Name') typedUser = value;
      if (label === 'Password') typedPass = value;
      return originalFill(label, value, signal);
    };
    return driver;
  }

  /** Test seam: navigate without going through a click handler. */
  navigateTo(url: string): void {
    if (!this.pages.has(url)) throw new Error(`FakeDriver: unknown URL ${url}`);
    this.currentUrl = url;
  }

  /** Test seam: replace the current page's text. */
  setPageText(text: string): void {
    this.page.text = text;
  }

  private get page(): FakePage {
    const page = this.pages.get(this.currentUrl);
    if (!page) throw Errors.notFound('UI_PAGE_NOT_FOUND', 'No fake page for the current URL');
    return page;
  }

  private assertOpen(): void {
    if (this.closed) throw Errors.badRequest('UI_DRIVER_CLOSED', 'Browser session is closed');
  }

  async goto(url: string, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    this.assertOpen();
    if (!this.pages.has(url)) throw Errors.notFound('UI_PAGE_NOT_FOUND', `Unknown page: ${url}`);
    this.currentUrl = url;
  }

  async fillField(label: string, value: string, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    this.assertOpen();
    if (!(label in this.page.fields)) {
      throw Errors.notFound('UI_FIELD_NOT_FOUND', `No field labeled '${label}' on this screen`);
    }
    this.page.fields[label] = value;
    this.filledFields.push({ label, value });
  }

  async clickButton(label: string, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    this.assertOpen();
    const handler = this.page.buttons[label];
    if (!handler) throw Errors.notFound('UI_BUTTON_NOT_FOUND', `No button labeled '${label}' on this screen`);
    this.clickedButtons.push(label);
    handler(this);
  }

  async readScreen(signal: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    this.assertOpen();
    const page = this.page;
    const lines = [page.text];
    for (const label of Object.keys(page.fields)) lines.push(`[field] ${label}`);
    for (const label of Object.keys(page.buttons)) lines.push(`[button] ${label}`);
    return lines.join('\n');
  }

  async screenshot(_signal: AbortSignal): Promise<Buffer> {
    this.assertOpen();
    // Deterministic pseudo-bytes: stable across runs, unique per page.
    return Buffer.from(`FAKE-SCREENSHOT:${this.currentUrl}`, 'utf8');
  }

  async waitForText(text: string, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    this.assertOpen();
    const screen = await this.readScreen(signal);
    if (!screen.includes(text)) {
      throw Errors.badRequest('UI_TEXT_NOT_FOUND', `Timed out waiting for text '${text}'`);
    }
  }

  async assertVisible(label: string, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    this.assertOpen();
    const page = this.page;
    if (!(label in page.fields) && !(label in page.buttons)) {
      throw Errors.notFound('UI_CONTROL_NOT_FOUND', `No visible control labeled '${label}'`);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get url(): string {
    return this.currentUrl;
  }
}
