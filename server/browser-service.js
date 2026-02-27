import { chromium } from 'playwright-core';

const SESSION_IDLE_TIMEOUT = 10 * 60 * 1000; // 10 minutes
const BDMS_READY_TIMEOUT = 30000; // 30 seconds

const BLOCKED_RESOURCE_TYPES = ['image', 'font', 'media'];

class BrowserService {
  constructor() {
    this.browser = null;
    this.sessions = new Map();
  }

  async ensureBrowser() {
    if (this.browser) return this.browser;

    console.log('[browser] 正在启动 Chromium...');
    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
      ],
    });
    console.log('[browser] Chromium 已启动');
    return this.browser;
  }

  getSessionCacheKey(sessionId, platformKey) {
    return `${platformKey}:${sessionId}`;
  }

  async getSession(sessionId, webId, userId, platformConfig) {
    const cacheKey = this.getSessionCacheKey(sessionId, platformConfig.key);
    const existing = this.sessions.get(cacheKey);
    if (existing) {
      existing.lastUsed = Date.now();
      this.resetIdleTimer(cacheKey, existing);
      return existing;
    }

    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
    });

    // Inject cookies
    const cookieDomain = platformConfig.cookieDomain || '.jianying.com';
    const cookies = [
      { name: '_tea_web_id', value: String(webId), domain: cookieDomain, path: '/' },
      { name: 'is_staff_user', value: 'false', domain: cookieDomain, path: '/' },
      { name: 'store-region', value: 'cn-gd', domain: cookieDomain, path: '/' },
      { name: 'uid_tt', value: String(userId), domain: cookieDomain, path: '/' },
      { name: 'sid_tt', value: sessionId, domain: cookieDomain, path: '/' },
      { name: 'sessionid', value: sessionId, domain: cookieDomain, path: '/' },
      { name: 'sessionid_ss', value: sessionId, domain: cookieDomain, path: '/' },
    ];
    await context.addCookies(cookies);

    // Block non-essential resources
    await context.route('**/*', (route) => {
      const request = route.request();
      const resourceType = request.resourceType();

      if (BLOCKED_RESOURCE_TYPES.includes(resourceType)) {
        return route.abort();
      }

      return route.continue();
    });

    const page = await context.newPage();

    console.log(
      `[browser][${platformConfig.name}] 正在导航到生成页 (session: ${sessionId.substring(0, 8)}...)`
    );
    await page.goto(platformConfig.generatePageUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });

    // Wait for bdms SDK to load
    try {
      await page.waitForFunction(
        () => {
          return (
            window.bdms?.init ||
            window.byted_acrawler ||
            window.fetch.toString().indexOf('native code') === -1
          );
        },
        { timeout: BDMS_READY_TIMEOUT }
      );
      console.log('[browser] bdms SDK 已就绪');
    } catch {
      console.warn('[browser] bdms SDK 等待超时，继续尝试...');
    }

    const session = {
      context,
      page,
      platformKey: platformConfig.key,
      platformName: platformConfig.name,
      sessionId,
      lastUsed: Date.now(),
      idleTimer: null,
    };
    this.resetIdleTimer(cacheKey, session);

    this.sessions.set(cacheKey, session);
    console.log(
      `[browser][${platformConfig.name}] 会话已创建 (session: ${sessionId.substring(0, 8)}...)`
    );
    return session;
  }

  resetIdleTimer(cacheKey, session) {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
    }
    session.idleTimer = setTimeout(
      () => this.closeSessionByKey(cacheKey),
      SESSION_IDLE_TIMEOUT
    );
  }

  async closeSessionByKey(cacheKey) {
    const session = this.sessions.get(cacheKey);
    if (!session) return;

    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
    }

    try {
      await session.context.close();
    } catch {
      // ignore
    }

    this.sessions.delete(cacheKey);
    console.log(
      `[browser][${session.platformName}] 会话已关闭 (session: ${session.sessionId.substring(0, 8)}...)`
    );
  }

  async closeSession(sessionId, platformConfig) {
    const cacheKey = this.getSessionCacheKey(sessionId, platformConfig.key);
    await this.closeSessionByKey(cacheKey);
  }

  async fetch(sessionId, webId, userId, url, options = {}, platformConfig) {
    const session = await this.getSession(
      sessionId,
      webId,
      userId,
      platformConfig
    );
    const { method = 'GET', headers = {}, body } = options;

    console.log(`[browser] 通过浏览器代理请求: ${method} ${url.substring(0, 80)}...`);

    const result = await session.page.evaluate(
      async ({ url, method, headers, body }) => {
        const resp = await fetch(url, {
          method,
          headers,
          body: body || undefined,
          credentials: 'include',
        });
        return resp.json();
      },
      { url, method, headers, body }
    );

    return result;
  }

  async refreshSession(sessionId, webId, userId, platformConfig) {
    await this.closeSession(sessionId, platformConfig);
    return this.getSession(sessionId, webId, userId, platformConfig);
  }

  async close() {
    for (const [cacheKey] of this.sessions) {
      await this.closeSessionByKey(cacheKey);
    }

    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        // ignore
      }
      this.browser = null;
      console.log('[browser] Chromium 已关闭');
    }
  }
}

const browserService = new BrowserService();
export default browserService;
