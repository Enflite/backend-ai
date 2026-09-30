/**
 * playwrightDriver.ts — real Chromium UiDriver via Playwright.
 *
 * REQUIRES REAL SYTELINE: every method here drives a live browser against a
 * live SyteLine web client. Nothing in this file is exercised in CI — the
 * FakeDriver (fakeDriver.ts) covers the contract there.
 *
 * Playwright is an OPTIONAL dependency, loaded lazily through
 * `createRequire` (never a static import) so the backend boots, typechecks,
 * and builds with or without it installed. Requesting a UI session without
 * Playwright installed fails fast with a clear PLAYWRIGHT_UNAVAILABLE error.
 * Browser binaries come from `npx playwright install chromium` (see the
 * operator docs); the npm package alone is not enough to launch Chromium.
 *
 * Minimal local structural types below describe only the Playwright surface
 * this driver uses, so compilation never depends on the installed package's
 * type definitions.
 */

import { createRequire } from 'node:module';
import { Errors } from '../../errors.js';
import { config } from '../../config.js';
import type { UiDriver } from './driver.js';

// --- Minimal structural Playwright surface (no dependency on its types). ---

interface PlaywrightLocator {
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  click(options?: { timeout?: number }): Promise<void>;
  waitFor(options?: { state?: string; timeout?: number }): Promise<void>;
}

interface PlaywrightPage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  getByLabel(label: string, options?: { exact?: boolean }): PlaywrightLocator;
  getByRole(role: string, options?: { name?: string; exact?: boolean }): PlaywrightLocator;
  getByText(text: string, options?: { exact?: boolean }): PlaywrightLocator;
  screenshot(options?: { fullPage?: boolean; timeout?: number }): Promise<Buffer>;
  /** pageFunction may be a function source string (Playwright evaluates it in-page). */
  evaluate<R>(pageFunction: string | (() => R)): Promise<R>;
  close(): Promise<void>;
}

interface PlaywrightBrowser {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

interface PlaywrightApi {
  chromium: {
    launch(options?: { headless?: boolean; timeout?: number }): Promise<PlaywrightBrowser>;
  };
}

function loadPlaywright(): PlaywrightApi {
  try {
    // Dynamic require (not a static import): the backend must boot and
    // typecheck whether or not the optional dependency is installed.
    const require = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('playwright') as PlaywrightApi;
  } catch {
    throw Errors.internal(
      'SyteLine UI automation needs the optional "playwright" package and a Chromium browser ' +
        '(`npm install` then `npx playwright install chromium`). Install them to use syteline.ui.* tools.',
      undefined,
      'PLAYWRIGHT_UNAVAILABLE',
    );
  }
}

function stepTimeoutMs(): number {
  return config.SYTELINE_UI_STEP_TIMEOUT_MS;
}

/**
 * Render an accessible snapshot of the page for the model: walks the DOM and
 * emits one line per visible interactive element with its role and accessible
 * name. Implemented via page.evaluate (no Playwright-version-sensitive
 * snapshot API), so it works with any Playwright 1.x.
 */
const SNAPSHOT_SCRIPT = `() => {
  const lines = [];
  const nameOf = (el) => {
    const labelledBy = el.getAttribute('aria-label');
    if (labelledBy) return labelledBy.trim();
    if (el.id) {
      const label = document.querySelector('label[for="' + el.id + '"]');
      if (label && label.textContent) return label.textContent.trim();
    }
    const text = (el.innerText || '').trim().replace(/\\s+/g, ' ');
    return text.slice(0, 120);
  };
  const els = document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"], h1, h2');
  els.forEach((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || tag;
    const name = nameOf(el);
    const value = (el.value !== undefined && (tag === 'input' || tag === 'textarea')) ? String(el.value).slice(0, 80) : '';
    lines.push('[' + role + '] ' + name + (value ? ' = "' + value + '"' : ''));
  });
  const title = document.title ? 'title: ' + document.title : '';
  const bodyText = (document.body ? document.body.innerText : '').trim().replace(/\\s+/g, ' ').slice(0, 4000);
  return [title, bodyText, ...lines].filter(Boolean).join('\\n');
}`;

export class PlaywrightDriver implements UiDriver {
  private constructor(
    private readonly browser: PlaywrightBrowser,
    private readonly page: PlaywrightPage,
  ) {}

  /** Launch headless Chromium and open a fresh page. */
  static async launch(): Promise<PlaywrightDriver> {
    const playwright = loadPlaywright();
    const browser = await playwright.chromium.launch({ headless: true, timeout: stepTimeoutMs() });
    const page = await browser.newPage();
    return new PlaywrightDriver(browser, page);
  }

  private checkSignal(signal: AbortSignal): void {
    if (signal.aborted) throw Errors.badRequest('TOOL_ABORTED', 'Tool call aborted');
  }

  async goto(url: string, signal: AbortSignal): Promise<void> {
    this.checkSignal(signal);
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: stepTimeoutMs() });
  }

  async fillField(label: string, value: string, signal: AbortSignal): Promise<void> {
    this.checkSignal(signal);
    // getByLabel matches <label> association and aria-label alike.
    await this.page.getByLabel(label, { exact: false }).fill(value, { timeout: stepTimeoutMs() });
  }

  async clickButton(label: string, signal: AbortSignal): Promise<void> {
    this.checkSignal(signal);
    await this.page
      .getByRole('button', { name: label, exact: false })
      .click({ timeout: stepTimeoutMs() });
  }

  async readScreen(signal: AbortSignal): Promise<string> {
    this.checkSignal(signal);
    // The script is a function-source string: Playwright evaluates it
    // in-page. Kept as a string (not a closure) so the driver never
    // depends on Playwright's function serialization.
    return this.page.evaluate<string>(SNAPSHOT_SCRIPT);
  }

  async screenshot(signal: AbortSignal): Promise<Buffer> {
    this.checkSignal(signal);
    return this.page.screenshot({ fullPage: false, timeout: stepTimeoutMs() });
  }

  async waitForText(text: string, signal: AbortSignal): Promise<void> {
    this.checkSignal(signal);
    await this.page.getByText(text, { exact: false }).waitFor({ timeout: stepTimeoutMs() });
  }

  async assertVisible(label: string, signal: AbortSignal): Promise<void> {
    this.checkSignal(signal);
    // A login field may surface as a labeled input or a named button.
    const locator = this.page.getByLabel(label, { exact: false });
    await locator.waitFor({ state: 'visible', timeout: stepTimeoutMs() });
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}
