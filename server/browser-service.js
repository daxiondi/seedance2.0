import { chromium } from 'playwright-core';

const SESSION_IDLE_TIMEOUT = 10 * 60 * 1000; // 10 minutes
const BDMS_READY_TIMEOUT = 30000; // 30 seconds

const BLOCKED_RESOURCE_TYPES = ['image', 'font', 'media'];

function createCookie(name, value, domain) {
  return { name, value: String(value), domain, path: '/' };
}

function parseCookieHeader(rawCookieHeader) {
  const cookieMap = new Map();
  if (typeof rawCookieHeader !== 'string' || !rawCookieHeader.trim()) {
    return cookieMap;
  }

  const fragments = rawCookieHeader.split(/[\n;]+/);
  for (const rawFragment of fragments) {
    const fragment = rawFragment.trim();
    if (!fragment) continue;
    const separatorIndex = fragment.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = fragment.slice(0, separatorIndex).trim();
    const value = fragment.slice(separatorIndex + 1).trim();
    if (key && value) cookieMap.set(key, value);
  }
  return cookieMap;
}

function buildAuthCookies(
  sessionId,
  webId,
  _userId,
  platformConfig,
  rawCookieHeader = ''
) {
  const primaryDomain = platformConfig.cookieDomain || '.jianying.com';
  const fromInput = parseCookieHeader(rawCookieHeader);
  if (fromInput.size > 0) {
    const cookies = [];
    for (const [name, value] of fromInput.entries()) {
      const domain =
        platformConfig?.key === 'xyq' && name.includes('_pippitcn_web')
          ? '.xyq.jianying.com'
          : primaryDomain;
      cookies.push(createCookie(name, value, domain));
    }
    return cookies;
  }

  if (platformConfig?.key === 'xyq') {
    const xyqDomain = '.xyq.jianying.com';
    return [
      createCookie('is_staff_user_pippitcn_web', 'false', xyqDomain),
      createCookie('sid_tt_pippitcn_web', sessionId, xyqDomain),
      createCookie('sessionid_pippitcn_web', sessionId, xyqDomain),
      createCookie('sessionid_ss_pippitcn_web', sessionId, xyqDomain)
    ];
  }

  return [
    createCookie('_tea_web_id', webId, primaryDomain),
    createCookie('is_staff_user', 'false', primaryDomain),
    createCookie('store-region', 'cn-gd', primaryDomain),
    createCookie('sid_tt', sessionId, primaryDomain),
    createCookie('sessionid', sessionId, primaryDomain),
    createCookie('sessionid_ss', sessionId, primaryDomain),
  ];
}

function previewBody(text, maxLength = 120) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function looksLikeHtmlResponse(contentType, text) {
  const normalizedType = String(contentType || '').toLowerCase();
  if (normalizedType.includes('text/html')) return true;

  const normalizedBody = String(text || '')
    .slice(0, 200)
    .toLowerCase();
  return (
    normalizedBody.includes('<!doctype html') || normalizedBody.includes('<html')
  );
}

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

  async getSession(sessionId, webId, userId, platformConfig, rawCookieHeader = '') {
    const cacheKey = this.getSessionCacheKey(
      `${sessionId}|${rawCookieHeader}`,
      platformConfig.key
    );
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
    const cookies = buildAuthCookies(
      sessionId,
      webId,
      userId,
      platformConfig,
      rawCookieHeader
    );
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

  async closeSession(sessionId, platformConfig, rawCookieHeader = '') {
    const cacheKey = this.getSessionCacheKey(
      `${sessionId}|${rawCookieHeader}`,
      platformConfig.key
    );
    await this.closeSessionByKey(cacheKey);
  }

  async fetch(
    sessionId,
    webId,
    userId,
    url,
    options = {},
    platformConfig,
    rawCookieHeader = ''
  ) {
    const session = await this.getSession(
      sessionId,
      webId,
      userId,
      platformConfig,
      rawCookieHeader
    );
    const { method = 'GET', headers = {}, body } = options;

    console.log(`[browser] 通过浏览器代理请求: ${method} ${url.substring(0, 80)}...`);

    let rawResult = null;
    try {
      rawResult = await session.page.evaluate(
        async ({ url, method, headers, body }) => {
          const resp = await fetch(url, {
            method,
            headers,
            body: body || undefined,
            credentials: 'include',
          });
          const text = await resp.text();
          return {
            ok: resp.ok,
            status: resp.status,
            contentType: resp.headers.get('content-type') || '',
            body: text,
          };
        },
        { url, method, headers, body }
      );
    } catch (error) {
      const message = error?.message || 'unknown error';
      if (String(message).includes('Failed to fetch')) {
        throw new Error(
          `${platformConfig.name}请求失败，通常是鉴权失效或触发安全校验，请在${platformConfig.baseUrl}重新登录并完成验证后重试`
        );
      }
      throw error;
    }

    const { status, contentType, body: responseBody } = rawResult;
    try {
      return JSON.parse(responseBody);
    } catch {
      if (looksLikeHtmlResponse(contentType, responseBody)) {
        throw new Error(
          `${platformConfig.name}鉴权失效或触发安全校验，请在${platformConfig.baseUrl}重新登录并完成验证后，更新最新 Cookie 中的 ${
            platformConfig.key === 'xyq'
              ? 'sessionid_pippitcn_web'
              : 'sessionid'
          }`
        );
      }

      throw new Error(
        `${platformConfig.name}浏览器代理返回非JSON (HTTP ${status}): ${previewBody(responseBody)}`
      );
    }
  }

  async refreshSession(sessionId, webId, userId, platformConfig, rawCookieHeader = '') {
    await this.closeSession(sessionId, platformConfig, rawCookieHeader);
    return this.getSession(sessionId, webId, userId, platformConfig, rawCookieHeader);
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
