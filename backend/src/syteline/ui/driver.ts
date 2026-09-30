/**
 * driver.ts — the UiDriver contract for agentic SyteLine UI automation.
 *
 * Two implementations:
 * - PlaywrightDriver (playwrightDriver.ts): real Chromium, REQUIRES REAL
 *   SYTELINE. Loaded lazily; the backend boots without Playwright installed.
 * - FakeDriver (fakeDriver.ts): deterministic in-memory driver for tests
 *   and CI (VALIDATED IN CI).
 *
 * Every method takes an AbortSignal: UI automation runs inside runToolCall's
 * AI_TOOL_TIMEOUT_MS deadline, and a hung browser must not hold a chat turn
 * or worker slot indefinitely.
 */

export interface UiDriver {
  /** Navigate to an absolute URL and wait for it to settle. */
  goto(url: string, signal: AbortSignal): Promise<void>;
  /** Fill the field identified by its accessible label/name. */
  fillField(label: string, value: string, signal: AbortSignal): Promise<void>;
  /** Click the button identified by its accessible name. May submit a form. */
  clickButton(label: string, signal: AbortSignal): Promise<void>;
  /** Accessible/ARIA snapshot text of the current screen (for the model). */
  readScreen(signal: AbortSignal): Promise<string>;
  /** Raw screenshot bytes (evidence; never returned to the model directly). */
  screenshot(signal: AbortSignal): Promise<Buffer>;
  /** Wait until the screen contains the given text (throws on timeout). */
  waitForText(text: string, signal: AbortSignal): Promise<void>;
  /** Assert a control with the given accessible name is visible (throws if not). */
  assertVisible(label: string, signal: AbortSignal): Promise<void>;
  /** Close the browser/page and release resources. */
  close(): Promise<void>;
}

/**
 * Perform the standard SyteLine web-client login: navigate to the base URL,
 * fill the username and password fields by accessible name, submit, and wait
 * for the post-login marker. Throws on timeout (bad credentials or an
 * unreachable client surface as a login failure, never a hang).
 *
 * REQUIRES REAL SYTELINE: the accessible names below are the documented
 * contract; a real SyteLine deployment that labels its login controls
 * differently will fail here until the names are adjusted.
 */
export async function loginSyteline(
  driver: UiDriver,
  username: string,
  password: string,
  baseUrl: string,
  signal: AbortSignal,
): Promise<void> {
  await driver.goto(baseUrl, signal);
  await driver.assertVisible('User Name', signal);
  await driver.fillField('User Name', username, signal);
  await driver.fillField('Password', password, signal);
  await driver.clickButton('Log In', signal);
  // Post-login marker: the SyteLine client lands on its home/navigation
  // surface after a successful login.
  await driver.waitForText('Home', signal);
}
