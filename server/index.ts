import cors from "cors";
import express from "express";
import multer from "multer";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import sharp from "sharp";
import type {
  AnalysisResult,
  ColorToken,
  FigmaExport,
  FigmaLayer,
  GeneratedSource,
  PageElement,
  StyleGuide,
  TypographyToken
} from "../src/types";

type CookieSameSite = "Strict" | "Lax" | "None";

interface AuthCookieOptions {
  useBrowserSession: boolean;
  includeCookies: boolean;
  cookieText: string;
}

interface ParsedCookie {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: CookieSameSite;
}

interface ActiveSession {
  context: BrowserContext;
  profileDir: string;
}

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 12 * 1024 * 1024
  }
});

const PORT = Number(process.env.PORT ?? 8787);
const DEFAULT_VIEWPORT = { width: 1440, height: 1000 };
const SESSION_ROOT = path.join(process.cwd(), ".rewind-sessions");
const DEFAULT_CDP_ENDPOINT = process.env.REWIND_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const activeSessions = new Map<string, ActiveSession>();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/session/open", async (req, res) => {
  const rawUrl = String(req.body?.url ?? "").trim();
  const viewport = normalizeViewport(req.body?.viewport);

  try {
    const url = normalizeUrl(rawUrl);
    const session = await openLoginSession(url, viewport);
    res.json({
      ok: true,
      message: "Login window opened. Finish login there, then run Reverse with browser login state enabled.",
      profile: session.profileDir
    });
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

app.post("/api/analyze/url", async (req, res) => {
  const rawUrl = String(req.body?.url ?? "").trim();
  const viewport = normalizeViewport(req.body?.viewport);
  const auth = normalizeAuthOptions(req.body?.auth);

  try {
    const url = normalizeUrl(rawUrl);
    const result = await analyzeUrl(url, viewport, auth);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

app.post("/api/analyze/screenshot", upload.single("screenshot"), async (req, res) => {
  try {
    if (!req.file) {
      throw new Error("Upload a screenshot file first.");
    }

    const label = String(req.body?.label ?? req.file.originalname ?? "Uploaded screenshot");
    const result = await analyzeScreenshot(req.file.buffer, label);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

app.listen(PORT, () => {
  console.log(`Rewind Any Web API listening on http://127.0.0.1:${PORT}`);
});

function normalizeViewport(input: unknown) {
  const asRecord = typeof input === "object" && input ? (input as Record<string, unknown>) : {};
  const width = clamp(Number(asRecord.width) || DEFAULT_VIEWPORT.width, 800, 1920);
  const height = clamp(Number(asRecord.height) || DEFAULT_VIEWPORT.height, 640, 1400);
  return { width, height };
}

function normalizeUrl(rawUrl: string) {
  if (!rawUrl) {
    throw new Error("Enter a URL to analyze.");
  }

  const withProtocol = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  const url = new URL(withProtocol);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http and https URLs are supported.");
  }
  return url.toString();
}

function normalizeAuthOptions(input: unknown): AuthCookieOptions {
  const asRecord = typeof input === "object" && input ? (input as Record<string, unknown>) : {};
  return {
    useBrowserSession: Boolean(asRecord.useBrowserSession),
    includeCookies: Boolean(asRecord.includeCookies),
    cookieText: String(asRecord.cookieText ?? "").trim()
  };
}

async function analyzeUrl(
  url: string,
  viewport: { width: number; height: number },
  auth: AuthCookieOptions
): Promise<AnalysisResult> {
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let closeContextWhenDone = true;

  try {
    if (auth.useBrowserSession) {
      const sessionContext = await getAuthenticatedSessionContext(url, viewport);
      context = sessionContext.context;
      browser = sessionContext.browser;
      closeContextWhenDone = sessionContext.closeContextWhenDone;
    } else {
      browser = await chromium.launch({
        headless: true,
        args: ["--disable-blink-features=AutomationControlled"]
      });
      context = await browser.newContext(browserContextOptions(viewport));
    }

    await context.addInitScript("Object.defineProperty(navigator, 'webdriver', { get: () => undefined })");
    await applyAuthCookies(context, url, auth);
    page = await context.newPage();

    await gotoPage(page, url);
    await page.waitForTimeout(900);

    const screenshot = await page.screenshot({ fullPage: false, type: "png" });
    const extraction = await collectPageModel(page);
    if (isBlockedPage(extraction.title, extraction.elements)) {
      if (auth.useBrowserSession && closeContextWhenDone) {
        await page.close().catch(() => undefined);
        await context.close().catch(() => undefined);
        context = null;
        page = null;
        return analyzeUrl(url, viewport, {
          ...auth,
          useBrowserSession: false
        });
      }

      throw new Error(
        auth.useBrowserSession
          ? "This browser session returned an anti-bot or verification screen. Open the login window, keep it available, then try again."
          : "This page returned an anti-bot or verification screen. Try screenshot mode for this target."
      );
    }
    const palette = await extractPaletteFromImage(screenshot);
    const styleGuide = buildStyleGuide({
      title: extraction.title,
      elements: extraction.elements,
      palette,
      mode: "url"
    });
    const source = buildUrlSource({
      url,
      title: extraction.title,
      elements: extraction.elements,
      styleGuide
    });
    const figma = buildFigmaExport({
      name: extraction.title || url,
      viewport,
      styleGuide,
      elements: extraction.elements,
      screenshotDataUrl: `data:image/png;base64,${screenshot.toString("base64")}`
    });

    return {
      id: crypto.randomUUID(),
      mode: "url",
      input: url,
      title: extraction.title || new URL(url).hostname,
      capturedAt: new Date().toISOString(),
      viewport,
      screenshotDataUrl: `data:image/png;base64,${screenshot.toString("base64")}`,
      elements: extraction.elements,
      styleGuide,
      source,
      figma,
      metrics: {
        visibleElements: extraction.elements.length,
        colorsSampled: palette.length,
        links: extraction.elements.filter((element) => element.tag === "a").length,
        buttons: extraction.elements.filter((element) => element.tag === "button" || element.role === "button").length,
        images: extraction.elements.filter((element) => element.tag === "img" || element.styles.backgroundImage !== "none").length
      }
    };
  } finally {
    if (!closeContextWhenDone) {
      await page?.close().catch(() => undefined);
    }
    if (closeContextWhenDone) {
      await context?.close().catch(() => undefined);
    }
    await browser?.close();
  }
}

function browserContextOptions(viewport: { width: number; height: number }) {
  return {
    viewport,
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  };
}

async function openLoginSession(url: string, viewport: { width: number; height: number }) {
  const key = sessionKey(url);
  const existing = activeSessions.get(key);
  if (existing) {
    const page = existing.context.pages()[0] ?? (await existing.context.newPage());
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35_000 });
    await page.bringToFront();
    return existing;
  }

  const profileDir = await sessionProfileDir(url);
  const context = await chromium.launchPersistentContext(profileDir, {
    ...browserContextOptions(viewport),
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"]
  });
  await context.addInitScript("Object.defineProperty(navigator, 'webdriver', { get: () => undefined })");
  context.on("close", () => {
    activeSessions.delete(key);
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35_000 });
  await page.bringToFront();

  const session = { context, profileDir };
  activeSessions.set(key, session);
  return session;
}

async function getBrowserSessionContext(url: string, viewport: { width: number; height: number }) {
  const existing = activeSessions.get(sessionKey(url));
  if (existing) {
    return {
      context: existing.context,
      closeContextWhenDone: false
    };
  }

  const profileDir = await sessionProfileDir(url);
  const context = await chromium.launchPersistentContext(profileDir, {
    ...browserContextOptions(viewport),
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"]
  });

  return {
    context,
    closeContextWhenDone: true
  };
}

async function getAuthenticatedSessionContext(url: string, viewport: { width: number; height: number }) {
  const cdpContext = await getCdpSessionContext(viewport).catch(() => null);
  if (cdpContext) {
    return cdpContext;
  }

  const profileContext = await getBrowserSessionContext(url, viewport);
  return {
    browser: null,
    context: profileContext.context,
    closeContextWhenDone: profileContext.closeContextWhenDone
  };
}

async function getCdpSessionContext(viewport: { width: number; height: number }) {
  const browser = await chromium.connectOverCDP(DEFAULT_CDP_ENDPOINT, {
    timeout: 1500
  });
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close().catch(() => undefined);
    throw new Error("Connected to CDP, but no default browser context was available.");
  }

  for (const page of context.pages()) {
    await page.setViewportSize(viewport).catch(() => undefined);
  }

  return {
    browser,
    context,
    closeContextWhenDone: false
  };
}

async function sessionProfileDir(url: string) {
  await mkdir(SESSION_ROOT, { recursive: true });
  const parsed = new URL(url);
  const profileName = `${parsed.protocol.replace(":", "")}-${parsed.hostname}-${parsed.port || "default"}`
    .replace(/[^a-z0-9._-]+/gi, "-")
    .toLowerCase();
  return path.join(SESSION_ROOT, profileName);
}

function sessionKey(url: string) {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

async function applyAuthCookies(context: BrowserContext, url: string, auth: AuthCookieOptions) {
  if (!auth.includeCookies) return;
  if (!auth.cookieText) {
    throw new Error("Paste cookie data or turn off login cookies.");
  }

  const cookies = parseCookieInput(auth.cookieText, url);
  if (!cookies.length) {
    throw new Error("No usable cookies were found. Paste a Cookie header, JSON export, or Netscape cookie file.");
  }

  await context.addCookies(cookies);
}

function parseCookieInput(rawCookieText: string, targetUrl: string): ParsedCookie[] {
  const text = rawCookieText.trim();
  if (!text) return [];
  if (text.length > 1_000_000) {
    throw new Error("Cookie payload is too large. Keep it under 1 MB.");
  }

  const cookies = text.startsWith("{") || text.startsWith("[")
    ? parseJsonCookies(text, targetUrl)
    : looksLikeNetscapeCookies(text)
      ? parseNetscapeCookies(text)
      : parseCookieHeader(text, targetUrl);

  const normalized = cookies.map((cookie) => normalizeCookie(cookie, targetUrl)).filter(Boolean) as ParsedCookie[];
  if (normalized.length > 200) {
    throw new Error("Too many cookies. Keep the import under 200 cookies for one rewind request.");
  }
  return normalized;
}

function parseJsonCookies(text: string, targetUrl: string): ParsedCookie[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Cookie JSON is invalid.");
  }

  if (Array.isArray(parsed)) {
    return parsed.flatMap((item) => cookieFromUnknown(item, targetUrl));
  }

  if (typeof parsed === "object" && parsed) {
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record.cookies)) {
      return record.cookies.flatMap((item) => cookieFromUnknown(item, targetUrl));
    }

    if ("name" in record && "value" in record) {
      return cookieFromUnknown(record, targetUrl);
    }

    return Object.entries(record).flatMap(([name, value]) =>
      typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? [{ name, value: String(value), url: targetUrl }]
        : []
    );
  }

  return [];
}

function cookieFromUnknown(input: unknown, targetUrl: string): ParsedCookie[] {
  if (typeof input !== "object" || !input) return [];
  const record = input as Record<string, unknown>;
  const name = String(record.name ?? "").trim();
  const value = String(record.value ?? "");
  if (!name) return [];

  const domain = typeof record.domain === "string" && record.domain ? record.domain : undefined;
  const path = typeof record.path === "string" && record.path ? record.path : "/";
  const expiresValue = Number(record.expires ?? record.expirationDate ?? record.expiry);
  const cookie: ParsedCookie = {
    name,
    value,
    path,
    httpOnly: Boolean(record.httpOnly),
    secure: Boolean(record.secure),
    sameSite: normalizeSameSite(record.sameSite)
  };

  if (domain) {
    cookie.domain = domain;
  } else {
    cookie.url = targetUrl;
  }

  if (Number.isFinite(expiresValue) && expiresValue > 0) {
    cookie.expires = Math.floor(expiresValue);
  }

  return [cookie];
}

function parseCookieHeader(text: string, targetUrl: string): ParsedCookie[] {
  const header = text.replace(/^cookie:\s*/i, "");
  return header
    .split(";")
    .map((part) => part.trim())
    .flatMap((part) => {
      const separatorIndex = part.indexOf("=");
      if (separatorIndex <= 0) return [];
      const name = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1).trim();
      return name ? [{ name, value, url: targetUrl }] : [];
    });
}

function parseNetscapeCookies(text: string): ParsedCookie[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .flatMap((line) => {
      if (!line || (line.startsWith("#") && !line.startsWith("#HttpOnly_"))) return [];

      const httpOnly = line.startsWith("#HttpOnly_");
      const normalizedLine = httpOnly ? line.replace(/^#HttpOnly_/, "") : line;
      const parts = normalizedLine.includes("\t") ? normalizedLine.split("\t") : normalizedLine.split(/\s+/);
      if (parts.length < 7) return [];

      const [domain, , path, secure, expires, name, ...valueParts] = parts;
      const expiresNumber = Number(expires);
      const cookie: ParsedCookie = {
        name,
        value: valueParts.join(" "),
        domain,
        path: path || "/",
        httpOnly,
        secure: /^true$/i.test(secure)
      };

      if (Number.isFinite(expiresNumber) && expiresNumber > 0) {
        cookie.expires = Math.floor(expiresNumber);
      }

      return cookie.name ? [cookie] : [];
    });
}

function looksLikeNetscapeCookies(text: string) {
  return text
    .split(/\r?\n/)
    .some((line) => /^#HttpOnly_|^[^\s]+\s+(TRUE|FALSE)\s+\S+\s+(TRUE|FALSE)\s+\d+\s+\S+\s+/i.test(line.trim()));
}

function normalizeCookie(cookie: ParsedCookie, targetUrl: string): ParsedCookie | null {
  const name = cookie.name.trim();
  if (!name || /[\s;=]/.test(name)) return null;

  const normalized: ParsedCookie = {
    name,
    value: cookie.value,
    path: cookie.path || "/",
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite
  };

  if (cookie.domain) {
    normalized.domain = cookie.domain;
    normalized.path = cookie.path || "/";
  } else {
    normalized.url = cookie.url || targetUrl;
    delete normalized.path;
  }

  if (cookie.expires && Number.isFinite(cookie.expires) && cookie.expires > 0) {
    normalized.expires = cookie.expires;
  }

  return normalized;
}

function normalizeSameSite(value: unknown): CookieSameSite | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();
  if (normalized === "strict") return "Strict";
  if (normalized === "lax") return "Lax";
  if (normalized === "none" || normalized === "no_restriction") return "None";
  return undefined;
}

function isBlockedPage(title: string, elements: PageElement[]) {
  const joinedText = elements
    .slice(0, 20)
    .map((element) => element.text)
    .join(" ");
  return /attention required|cloudflare|verify you are human|access denied/i.test(`${title} ${joinedText}`);
}

async function gotoPage(page: Page, url: string) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35_000 });
  try {
    await page.waitForLoadState("networkidle", { timeout: 5_000 });
  } catch {
    // Modern marketing sites often keep analytics or streaming requests open.
  }
}

async function collectPageModel(page: Page): Promise<{ title: string; elements: PageElement[] }> {
  const result = await page.evaluate(pageModelScript);
  return result as { title: string; elements: PageElement[] };
}

const pageModelScript = String.raw`(() => {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const importantTags = new Set([
    "a",
    "button",
    "footer",
    "h1",
    "h2",
    "h3",
    "header",
    "img",
    "input",
    "main",
    "nav",
    "p",
    "section",
    "textarea"
  ]);

  const cleanText = (text) => (text ?? "").replace(/\s+/g, " ").trim().slice(0, 180);

  const isVisible = (element, rect, styles) => {
    if (rect.width < 2 || rect.height < 2) return false;
    if (Number(styles.opacity) < 0.05 || styles.visibility === "hidden" || styles.display === "none") return false;
    if (rect.bottom < -viewportHeight * 0.5 || rect.top > viewportHeight * 2.5) return false;
    if (rect.right < -viewportWidth * 0.5 || rect.left > viewportWidth * 1.5) return false;
    return element.getClientRects().length > 0;
  };

  const shouldKeep = (element, tag, text, styles) => {
    const role = element.getAttribute("role");
    const hasVisualBackground = styles.backgroundImage !== "none" || styles.backgroundColor !== "rgba(0, 0, 0, 0)";
    const isInput = tag === "input" || tag === "textarea";
    return importantTags.has(tag) || Boolean(text) || Boolean(role) || hasVisualBackground || isInput;
  };

  const candidates = Array.from(document.querySelectorAll("body *"));
  const seenText = new Map();

  const elements = candidates.flatMap((element, index) => {
    const tag = element.tagName.toLowerCase();
    const rect = element.getBoundingClientRect();
    const styles = window.getComputedStyle(element);
    const text = cleanText(
      tag === "input" || tag === "textarea"
        ? element.placeholder
        : element.innerText
    );

    if (!isVisible(element, rect, styles) || !shouldKeep(element, tag, text, styles)) {
      return [];
    }

    if (text) {
      const duplicateCount = seenText.get(text) ?? 0;
      seenText.set(text, duplicateCount + 1);
      if (duplicateCount > 2 && !importantTags.has(tag)) return [];
    }

    const item = {
      id: "node-" + index,
      tag,
      role: element.getAttribute("role"),
      text,
      href: tag === "a" ? element.href : null,
      src: tag === "img" ? element.currentSrc || element.src : null,
      placeholder: tag === "input" || tag === "textarea" ? element.placeholder : null,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      styles: {
        color: styles.color,
        backgroundColor: styles.backgroundColor,
        borderColor: styles.borderColor,
        borderRadius: styles.borderRadius,
        boxShadow: styles.boxShadow,
        fontFamily: styles.fontFamily,
        fontSize: styles.fontSize,
        fontWeight: styles.fontWeight,
        letterSpacing: styles.letterSpacing,
        lineHeight: styles.lineHeight,
        opacity: styles.opacity,
        textTransform: styles.textTransform,
        backdropFilter: styles.backdropFilter,
        backgroundImage: styles.backgroundImage
      }
    };

    return [item];
  });

  return {
    title: document.title,
    elements: elements
      .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
      .slice(0, 220)
  };
})()`;

async function analyzeScreenshot(buffer: Buffer, label: string): Promise<AnalysisResult> {
  const image = sharp(buffer);
  const metadata = await image.metadata();
  const width = metadata.width ?? DEFAULT_VIEWPORT.width;
  const height = metadata.height ?? DEFAULT_VIEWPORT.height;
  const palette = await extractPaletteFromImage(buffer);
  const elements = buildScreenshotElements({ width, height, palette, label });
  const styleGuide = buildStyleGuide({
    title: label,
    elements,
    palette,
    mode: "screenshot"
  });
  const screenshotDataUrl = `data:${metadata.format ? `image/${metadata.format}` : "image/png"};base64,${buffer.toString("base64")}`;
  const source = buildScreenshotSource({ label, width, height, styleGuide });
  const figma = buildFigmaExport({
    name: label,
    viewport: { width, height },
    styleGuide,
    elements,
    screenshotDataUrl,
    lockImageAsReference: true
  });

  return {
    id: crypto.randomUUID(),
    mode: "screenshot",
    input: label,
    title: label,
    capturedAt: new Date().toISOString(),
    viewport: { width, height },
    screenshotDataUrl,
    elements,
    styleGuide,
    source,
    figma,
    metrics: {
      visibleElements: elements.length,
      colorsSampled: palette.length,
      links: 0,
      buttons: elements.filter((element) => element.role === "button").length,
      images: 1
    }
  };
}

async function extractPaletteFromImage(buffer: Buffer): Promise<ColorToken[]> {
  const { data } = await sharp(buffer)
    .resize({ width: 120, height: 120, fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const buckets = new Map<string, number>();
  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3];
    if (alpha < 24) continue;
    const red = quantize(data[index]);
    const green = quantize(data[index + 1]);
    const blue = quantize(data[index + 2]);
    const key = rgbToHex(red, green, blue);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }

  const entries = Array.from(buckets.entries());
  const frequent = [...entries].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const vivid = [...entries]
    .filter(([value]) => luminance(value) > 0.04 && luminance(value) < 0.96 && saturation(value) > 0.12)
    .sort((a, b) => vividScore(b) - vividScore(a))
    .slice(0, 8);
  const selected = uniqueColorEntries([...frequent, ...vivid]).slice(0, 12);

  return selected.map(([value, count], index) => ({
      name: index === 0 ? "canvas" : `sample-${index}`,
      value,
      usage: index === 0 ? "Dominant sampled color" : "Prominent sampled color",
      count
    }));
}

function vividScore([value, count]: [string, number]) {
  const brightness = Math.min(luminance(value) * 2.4, 1);
  return saturation(value) * brightness * Math.sqrt(count);
}

function uniqueColorEntries(entries: Array<[string, number]>) {
  const seen = new Set<string>();
  return entries.filter(([value]) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function buildStyleGuide(input: {
  title: string;
  elements: PageElement[];
  palette: ColorToken[];
  mode: "url" | "screenshot";
}): StyleGuide {
  const cssColors = collectCssColors(input.elements);
  const colors = mergeColors(input.palette, cssColors);
  const sortedByLuminance = [...colors].sort((a, b) => luminance(a.value) - luminance(b.value));
  const darkest = sortedByLuminance[0]?.value ?? "#050505";
  const lightest = sortedByLuminance.at(-1)?.value ?? "#ffffff";
  const accent =
    colors.find((color) => saturation(color.value) > 0.16 && luminance(color.value) > 0.12 && luminance(color.value) < 0.9)?.value ??
    colors.find((color) => saturation(color.value) > 0.16 && color.value !== darkest && color.value !== lightest)?.value ??
    colors[1]?.value ??
    "#9ca3af";

  const namedColors: ColorToken[] = [
    { name: "background", value: darkest, usage: "Primary canvas" },
    { name: "foreground", value: lightest, usage: "Primary text and high contrast controls" },
    { name: "accent", value: accent, usage: "Glow, active state, or main call-to-action" },
    ...colors
      .filter((color) => ![darkest, lightest, accent].includes(color.value))
      .slice(0, 5)
      .map((color, index) => ({ ...color, name: `support-${index + 1}` }))
  ];

  const typography = extractTypography(input.elements);
  const radii = uniqueValues(input.elements.map((element) => element.styles.borderRadius).filter(Boolean))
    .filter((value) => value !== "0px")
    .slice(0, 8);
  const effects = uniqueValues(
    input.elements.flatMap((element) => [
      element.styles.boxShadow !== "none" ? element.styles.boxShadow : "",
      element.styles.backdropFilter !== "none" ? element.styles.backdropFilter : "",
      element.styles.backgroundImage !== "none" ? "large atmospheric image or gradient field" : ""
    ])
  )
    .filter(Boolean)
    .slice(0, 8);

  const notes =
    input.mode === "url"
      ? [
          "Use the captured DOM order as the source of truth for content hierarchy.",
          "The generated React/CSS is a reconstruction scaffold; final fidelity improves by replacing sampled effects with exact assets."
        ]
      : [
          "Screenshot mode cannot read semantic text without a vision/OCR adapter, so the scaffold keeps a reference layer and extracted visual tokens.",
          "Use this as the Figma tracing base, then swap placeholder labels with semantic copy."
        ];

  return {
    summary: `${input.title || "Captured page"} reads as a ${isDark(darkest) ? "dark" : "light"} interface with ${namedColors.length} extracted color tokens and ${typography.length} typography roles.`,
    colors: namedColors,
    typography,
    radii: radii.length ? radii : ["8px", "16px", "999px"],
    spacing: ["4px", "8px", "12px", "16px", "24px", "32px", "48px", "72px", "96px"],
    effects: effects.length ? effects : ["subtle border", "soft shadow", "viewport-scale background treatment"],
    notes
  };
}

function buildUrlSource(input: {
  url: string;
  title: string;
  elements: PageElement[];
  styleGuide: StyleGuide;
}): GeneratedSource {
  const hostname = new URL(input.url).hostname.replace(/^www\./, "");
  const navItems = input.elements
    .filter((element) => element.tag === "a" && element.rect.y < 180 && element.text)
    .map((element) => element.text)
    .filter(uniqueFilter)
    .slice(0, 9);
  const hero = findHeroElement(input.elements);
  const field = input.elements.find((element) => ["input", "textarea"].includes(element.tag) && (element.placeholder || element.text));
  const announcement =
    input.elements.find((element) => /announc|fast|launch|news|release/i.test(element.text)) ??
    input.elements.find((element) => element.tag === "p" && element.text.length > 24);
  const ctas = input.elements
    .filter((element) => ["button", "a"].includes(element.tag) && element.text && element.rect.y < 900)
    .map((element) => element.text)
    .filter(uniqueFilter)
    .slice(0, 2);
  const lowerCards = input.elements
    .filter((element) => ["h2", "h3", "p", "a"].includes(element.tag) && element.rect.y > 850 && element.text)
    .map((element) => element.text)
    .filter(uniqueFilter)
    .slice(0, 6);

  const componentName = toComponentName(hostname);
  const colors = input.styleGuide.colors;
  const background = getToken(colors, "background", "#050505");
  const foreground = getToken(colors, "foreground", "#f7f7f7");
  const accent = getToken(colors, "accent", "#9fb7ff");
  const surface = colors[3]?.value ?? "#0c0c0f";
  const font = input.styleGuide.typography[0]?.fontFamily ?? "Inter, ui-sans-serif, system-ui";
  const navLiteral = JSON.stringify(navItems.length ? navItems : ["Grok", "API", "Company", "Careers", "News"]);
  const cardLiteral = JSON.stringify(lowerCards.length ? lowerCards : ["AI for all humanity", "Build now", "Latest news"]);
  const titleLiteral = JSON.stringify(hero?.text || input.title || hostname);
  const fieldLiteral = JSON.stringify(field?.placeholder || field?.text || "What do you want to know?");
  const announcementLiteral = JSON.stringify(announcement?.text || "Announcing the latest update.");
  const ctaLiteral = JSON.stringify(ctas.length ? ctas : ["Try now", "Read announcement"]);

  const tsx = `import "./${componentName}.css";

const navItems = ${navLiteral};
const cards = ${cardLiteral};
const ctas = ${ctaLiteral};

export default function ${componentName}() {
  return (
    <main className="rewind-page">
      <header className="rewind-nav">
        <a className="rewind-brand" href="#">
          ${escapeJsxText(hostname)}
        </a>
        <nav aria-label="Primary">
          {navItems.map((item) => (
            <a key={item} href="#">
              {item}
            </a>
          ))}
        </nav>
        <a className="rewind-pill" href="#">
          {ctas[0]}
        </a>
      </header>

      <section className="rewind-hero">
        <div className="rewind-atmosphere" aria-hidden="true" />
        <h1>${escapeJsxText(JSON.parse(titleLiteral))}</h1>
        <form className="rewind-prompt">
          <span>${escapeJsxText(JSON.parse(fieldLiteral))}</span>
          <button type="button" aria-label="Submit prompt">↑</button>
        </form>
        <div className="rewind-announcement">
          <p>${escapeJsxText(JSON.parse(announcementLiteral))}</p>
          <a href="#">{ctas[1] ?? "Read more"}</a>
        </div>
      </section>

      <section className="rewind-grid" aria-label="Captured content">
        {cards.map((card) => (
          <article key={card}>
            <h2>{card}</h2>
            <p>Recreated from captured DOM hierarchy, computed styles, and viewport geometry.</p>
          </article>
        ))}
      </section>
    </main>
  );
}
`;

  const css = `:root {
  --rewind-bg: ${background};
  --rewind-fg: ${foreground};
  --rewind-muted: color-mix(in srgb, var(--rewind-fg) 62%, transparent);
  --rewind-accent: ${accent};
  --rewind-surface: ${surface};
  --rewind-border: color-mix(in srgb, var(--rewind-fg) 24%, transparent);
  --rewind-font: ${font};
}

body {
  margin: 0;
  background: var(--rewind-bg);
}

.rewind-page {
  min-height: 100vh;
  overflow: hidden;
  background:
    radial-gradient(circle at 90% 42%, color-mix(in srgb, var(--rewind-accent) 56%, white) 0 10%, transparent 28%),
    radial-gradient(circle at 62% 56%, color-mix(in srgb, var(--rewind-accent) 34%, transparent) 0 14%, transparent 34%),
    linear-gradient(180deg, color-mix(in srgb, var(--rewind-bg) 88%, #111827), var(--rewind-bg));
  color: var(--rewind-fg);
  font-family: var(--rewind-font);
}

.rewind-nav {
  position: sticky;
  top: 0;
  z-index: 2;
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 32px;
  padding: 28px clamp(24px, 7vw, 96px);
}

.rewind-brand,
.rewind-nav a,
.rewind-pill {
  color: inherit;
  text-decoration: none;
}

.rewind-brand {
  font-size: 28px;
  font-weight: 800;
  letter-spacing: 0;
}

.rewind-nav nav {
  display: flex;
  flex-wrap: wrap;
  gap: clamp(18px, 3vw, 44px);
}

.rewind-nav nav a,
.rewind-pill {
  color: var(--rewind-muted);
  font-size: 12px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

.rewind-pill {
  border: 1px solid var(--rewind-border);
  border-radius: 999px;
  padding: 14px 22px;
}

.rewind-hero {
  position: relative;
  display: grid;
  min-height: 72vh;
  place-items: center;
  padding: 48px 24px 96px;
}

.rewind-atmosphere {
  position: absolute;
  inset: 6% -8% 0 30%;
  background:
    radial-gradient(circle at 82% 42%, color-mix(in srgb, var(--rewind-fg) 88%, var(--rewind-accent)) 0 8%, transparent 24%),
    radial-gradient(circle at 40% 55%, color-mix(in srgb, var(--rewind-accent) 42%, transparent) 0 18%, transparent 42%);
  filter: blur(26px);
  opacity: 0.76;
}

.rewind-hero h1 {
  position: relative;
  margin: 0;
  max-width: 980px;
  color: color-mix(in srgb, var(--rewind-fg) 82%, var(--rewind-accent));
  font-size: clamp(72px, 16vw, 220px);
  font-weight: 700;
  line-height: 0.86;
  text-align: center;
}

.rewind-prompt {
  position: relative;
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: end;
  width: min(760px, calc(100vw - 48px));
  min-height: 104px;
  margin-top: -16px;
  padding: 24px;
  border: 1px solid var(--rewind-border);
  border-radius: 24px;
  background: color-mix(in srgb, var(--rewind-bg) 92%, black);
  box-shadow: 0 24px 80px rgb(0 0 0 / 42%);
}

.rewind-prompt span {
  color: var(--rewind-muted);
  font-size: 17px;
}

.rewind-prompt button {
  width: 42px;
  height: 42px;
  border: 0;
  border-radius: 999px;
  background: color-mix(in srgb, var(--rewind-fg) 72%, var(--rewind-muted));
  color: var(--rewind-bg);
  font-size: 24px;
}

.rewind-announcement {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 32px;
  width: min(900px, calc(100vw - 48px));
  margin-top: 56px;
}

.rewind-announcement p {
  margin: 0;
  max-width: 520px;
  font-size: 20px;
  line-height: 1.35;
}

.rewind-announcement a {
  border: 1px solid var(--rewind-border);
  border-radius: 999px;
  color: var(--rewind-fg);
  padding: 14px 22px;
  text-decoration: none;
  text-transform: uppercase;
}

.rewind-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 1px;
  border-top: 1px solid var(--rewind-border);
  background: var(--rewind-border);
}

.rewind-grid article {
  min-height: 220px;
  padding: 32px;
  background: var(--rewind-bg);
}

.rewind-grid h2 {
  margin: 0 0 16px;
  font-size: 24px;
}

.rewind-grid p {
  color: var(--rewind-muted);
  line-height: 1.6;
}
`;

  return {
    framework: "React",
    componentName,
    tsx,
    css,
    notes: [
      "This is a generated reconstruction scaffold, not a byte-for-byte clone.",
      "Replace atmospheric CSS gradients with extracted raster assets when exact fidelity is required."
    ]
  };
}

function buildScreenshotSource(input: {
  label: string;
  width: number;
  height: number;
  styleGuide: StyleGuide;
}): GeneratedSource {
  const componentName = toComponentName(input.label || "ScreenshotCapture");
  const background = getToken(input.styleGuide.colors, "background", "#050505");
  const foreground = getToken(input.styleGuide.colors, "foreground", "#ffffff");
  const accent = getToken(input.styleGuide.colors, "accent", "#9ca3af");
  const palette = JSON.stringify(input.styleGuide.colors.slice(0, 6).map((color) => color.value));

  return {
    framework: "React",
    componentName,
    tsx: `import "./${componentName}.css";

const palette = ${palette};

export default function ${componentName}() {
  return (
    <main className="screen-rewind" aria-label="Screenshot reconstruction">
      <section className="screen-canvas">
        <div className="screen-glow" />
        <header className="screen-toolbar">
          <strong>${escapeJsxText(input.label)}</strong>
          <nav>
            <a href="#">Primary</a>
            <a href="#">Secondary</a>
            <a href="#">Action</a>
          </nav>
        </header>
        <div className="screen-placeholder">
          <span>Reference-driven layout scaffold</span>
          <button type="button">↑</button>
        </div>
        <footer className="screen-palette">
          {palette.map((color) => (
            <i key={color} style={{ background: color }} />
          ))}
        </footer>
      </section>
    </main>
  );
}
`,
    css: `:root {
  --screen-bg: ${background};
  --screen-fg: ${foreground};
  --screen-accent: ${accent};
  --screen-border: color-mix(in srgb, var(--screen-fg) 22%, transparent);
}

body {
  margin: 0;
  background: var(--screen-bg);
}

.screen-rewind {
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: var(--screen-bg);
  color: var(--screen-fg);
  font-family: Inter, ui-sans-serif, system-ui;
  padding: 24px;
}

.screen-canvas {
  position: relative;
  width: min(100%, ${Math.min(input.width, 1440)}px);
  aspect-ratio: ${input.width} / ${input.height};
  overflow: hidden;
  border: 1px solid var(--screen-border);
  border-radius: 28px;
  background:
    radial-gradient(circle at 82% 42%, color-mix(in srgb, var(--screen-accent) 66%, white) 0 10%, transparent 30%),
    linear-gradient(180deg, color-mix(in srgb, var(--screen-bg) 88%, #111827), var(--screen-bg));
}

.screen-glow {
  position: absolute;
  inset: 16% -6% 8% 42%;
  background: var(--screen-accent);
  filter: blur(56px);
  opacity: 0.42;
}

.screen-toolbar {
  position: relative;
  display: flex;
  justify-content: space-between;
  gap: 24px;
  padding: clamp(18px, 4vw, 64px);
}

.screen-toolbar nav {
  display: flex;
  flex-wrap: wrap;
  gap: 28px;
}

.screen-toolbar a {
  color: color-mix(in srgb, var(--screen-fg) 68%, transparent);
  font-size: 12px;
  letter-spacing: 0.14em;
  text-decoration: none;
  text-transform: uppercase;
}

.screen-placeholder {
  position: absolute;
  left: 50%;
  top: 62%;
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: end;
  width: min(760px, calc(100% - 48px));
  min-height: 112px;
  padding: 24px;
  transform: translate(-50%, -50%);
  border: 1px solid var(--screen-border);
  border-radius: 24px;
  background: color-mix(in srgb, var(--screen-bg) 94%, black);
}

.screen-placeholder button {
  width: 44px;
  height: 44px;
  border: 0;
  border-radius: 999px;
}

.screen-palette {
  position: absolute;
  left: clamp(18px, 4vw, 64px);
  bottom: clamp(18px, 4vw, 64px);
  display: flex;
  gap: 10px;
}

.screen-palette i {
  width: 28px;
  height: 28px;
  border: 1px solid var(--screen-border);
  border-radius: 999px;
}
`,
    notes: [
      "Screenshot mode generates a reconstruction scaffold from palette and canvas geometry.",
      "For semantic text and exact component identification, connect a vision/OCR adapter to enrich this result."
    ]
  };
}

function buildFigmaExport(input: {
  name: string;
  viewport: { width: number; height: number };
  styleGuide: StyleGuide;
  elements: PageElement[];
  screenshotDataUrl?: string;
  lockImageAsReference?: boolean;
}): FigmaExport {
  const background = getToken(input.styleGuide.colors, "background", "#050505");
  const root: FigmaLayer = {
    id: "frame-root",
    type: "FRAME",
    name: `${input.name} / Rewind`,
    x: 0,
    y: 0,
    width: input.viewport.width,
    height: input.viewport.height,
    fills: [background],
    children: []
  };

  if (input.screenshotDataUrl && input.lockImageAsReference) {
    root.children?.push({
      id: "reference-image",
      type: "IMAGE",
      name: "Reference screenshot",
      x: 0,
      y: 0,
      width: input.viewport.width,
      height: input.viewport.height,
      opacity: 0.72,
      imageDataUrl: input.screenshotDataUrl
    });
  }

  const layers = input.elements
    .filter((element) => element.rect.width >= 4 && element.rect.height >= 4)
    .filter((element) => element.rect.y < input.viewport.height * 1.8)
    .slice(0, 90)
    .map((element, index) => elementToFigmaLayer(element, index));

  root.children?.push(...layers);

  return {
    name: root.name,
    viewport: input.viewport,
    tokens: {
      colors: input.styleGuide.colors,
      typography: input.styleGuide.typography,
      radii: input.styleGuide.radii
    },
    layers: [root],
    pluginInstructions: [
      "Create a root frame with the exported viewport size.",
      "Create TEXT layers for text nodes and RECTANGLE/ROUNDED_RECT layers for visual containers.",
      "Bind the exported color and typography tokens as local Figma styles before final cleanup.",
      "Screenshot-mode exports include a reference image layer for manual tracing or future vision enrichment."
    ],
    handoffPrompt: buildFigmaHandoffPrompt({
      name: input.name,
      viewport: input.viewport,
      styleGuide: input.styleGuide,
      elements: input.elements
    })
  };
}

function buildFigmaHandoffPrompt(input: {
  name: string;
  viewport: { width: number; height: number };
  styleGuide: StyleGuide;
  elements: PageElement[];
}) {
  const colors = input.styleGuide.colors
    .slice(0, 8)
    .map((color) => `- ${color.name}: ${color.value} (${color.usage})`)
    .join("\n");
  const type = input.styleGuide.typography
    .slice(0, 6)
    .map(
      (token) =>
        `- ${token.role}: ${token.fontSize}, weight ${token.fontWeight}, line ${token.lineHeight}, tracking ${token.letterSpacing}, family ${token.fontFamily}`
    )
    .join("\n");
  const navItems = input.elements
    .filter((element) => element.tag === "a" && element.rect.y < 220 && element.text)
    .map((element) => element.text)
    .filter(uniqueFilter)
    .slice(0, 10);
  const controls = input.elements
    .filter((element) => ["button", "input", "textarea"].includes(element.tag) || element.role === "button")
    .map((element) => element.text || element.placeholder || element.tag)
    .filter(uniqueFilter)
    .slice(0, 8);
  const contentPatterns = input.elements
    .filter((element) => ["h1", "h2", "h3", "p", "section"].includes(element.tag) && element.text)
    .map((element) => element.text)
    .filter(uniqueFilter)
    .slice(0, 8);
  const navLine = navItems.length ? navItems.join(", ") : "minimal top navigation";
  const controlsLine = controls.length ? controls.join(", ") : "pill buttons, prompt inputs, and rounded cards";
  const patternsLine = contentPatterns.length ? contentPatterns.join(" | ") : "large hero, short product modules, compact announcement band";

  return `Create a reusable Figma design system and one sample page inspired by "${input.name}".

Canvas:
- Desktop frame: ${input.viewport.width} x ${input.viewport.height}
- Use a responsive 12-column layout with generous side padding and dense, scan-friendly navigation.
- Keep the first viewport focused on the product or brand signal, with the next content section slightly visible below the fold.

Color tokens:
${colors}

Typography tokens:
${type}

Layout language:
- Overall mood: ${input.styleGuide.summary}
- Navigation: ${navLine}
- Controls: ${controlsLine}
- Content patterns: ${patternsLine}
- Spacing scale: ${input.styleGuide.spacing.join(", ")}
- Corner radius scale: ${input.styleGuide.radii.join(", ")}
- Effects: ${input.styleGuide.effects.join("; ")}

Figma deliverable:
- Build local color, text, radius, and effect styles first.
- Create components for nav item, pill button, prompt/control surface, announcement band, and content card.
- Create variants for default, hover, disabled, and emphasized states where relevant.
- Then compose a new landing page that follows the same visual grammar without copying the original content exactly.

Developer handoff:
- Include CSS custom properties for every token.
- Document component anatomy, spacing rules, responsive breakpoints, and interaction states.
- Treat this as a style generator: future pages should reuse the tokens and components, not the captured page layout verbatim.`;
}

function elementToFigmaLayer(element: PageElement, index: number): FigmaLayer {
  const background = cssColorToHex(element.styles.backgroundColor);
  const textColor = cssColorToHex(element.styles.color);
  const borderColor = cssColorToHex(element.styles.borderColor);
  const radius = parseFloat(element.styles.borderRadius) || 0;
  const isText =
    Boolean(element.text) &&
    ["a", "button", "h1", "h2", "h3", "p", "span", "strong", "label"].includes(element.tag);
  const type = isText ? "TEXT" : radius > 0 ? "ROUNDED_RECT" : "RECTANGLE";

  return {
    id: `layer-${index}-${element.id}`,
    type,
    name: element.text ? `${element.tag}: ${element.text.slice(0, 42)}` : element.tag,
    x: element.rect.x,
    y: element.rect.y,
    width: element.rect.width,
    height: element.rect.height,
    opacity: Number(element.styles.opacity) || 1,
    fills: type === "TEXT" ? [textColor ?? "#ffffff"] : background ? [background] : [],
    strokes: borderColor ? [borderColor] : [],
    cornerRadius: radius,
    text: type === "TEXT" ? element.text : undefined,
    fontFamily: element.styles.fontFamily,
    fontSize: parseFloat(element.styles.fontSize) || undefined,
    fontWeight: element.styles.fontWeight
  };
}

function buildScreenshotElements(input: {
  width: number;
  height: number;
  palette: ColorToken[];
  label: string;
}): PageElement[] {
  const background = input.palette[0]?.value ?? "#050505";
  const foreground = input.palette.find((color) => luminance(color.value) > 0.7)?.value ?? "#ffffff";
  const accent = input.palette.find((color) => saturation(color.value) > 0.18)?.value ?? input.palette[1]?.value ?? "#9ca3af";

  return [
    makeSyntheticElement({
      id: "image-frame",
      tag: "main",
      text: "",
      rect: { x: 0, y: 0, width: input.width, height: input.height },
      background,
      color: foreground,
      radius: "0px"
    }),
    makeSyntheticElement({
      id: "top-navigation",
      tag: "nav",
      text: "Captured navigation region",
      rect: { x: Math.round(input.width * 0.06), y: Math.round(input.height * 0.08), width: Math.round(input.width * 0.76), height: 56 },
      background: transparentColor(),
      color: foreground,
      radius: "999px"
    }),
    makeSyntheticElement({
      id: "hero-zone",
      tag: "section",
      text: input.label,
      rect: { x: Math.round(input.width * 0.22), y: Math.round(input.height * 0.38), width: Math.round(input.width * 0.56), height: Math.round(input.height * 0.32) },
      background: accent,
      color: foreground,
      radius: "24px",
      opacity: "0.28"
    }),
    makeSyntheticElement({
      id: "primary-control",
      tag: "button",
      role: "button",
      text: "Primary action region",
      rect: { x: Math.round(input.width * 0.36), y: Math.round(input.height * 0.66), width: Math.round(input.width * 0.42), height: Math.round(input.height * 0.12) },
      background: background,
      color: foreground,
      radius: "24px"
    })
  ];
}

function makeSyntheticElement(input: {
  id: string;
  tag: string;
  role?: string;
  text: string;
  rect: { x: number; y: number; width: number; height: number };
  background: string;
  color: string;
  radius: string;
  opacity?: string;
}): PageElement {
  return {
    id: input.id,
    tag: input.tag,
    role: input.role ?? null,
    text: input.text,
    rect: input.rect,
    styles: {
      color: input.color,
      backgroundColor: input.background,
      borderColor: "rgba(255, 255, 255, 0.22)",
      borderRadius: input.radius,
      boxShadow: "0 24px 80px rgba(0, 0, 0, 0.32)",
      fontFamily: "Inter, ui-sans-serif, system-ui",
      fontSize: "16px",
      fontWeight: "500",
      letterSpacing: "0px",
      lineHeight: "1.4",
      opacity: input.opacity ?? "1",
      textTransform: "none",
      backdropFilter: "none",
      backgroundImage: "none"
    }
  };
}

function collectCssColors(elements: PageElement[]) {
  const counts = new Map<string, number>();
  for (const element of elements) {
    for (const value of [element.styles.color, element.styles.backgroundColor, element.styles.borderColor]) {
      const hex = cssColorToHex(value);
      if (!hex) continue;
      counts.set(hex, (counts.get(hex) ?? 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([value, count], index) => ({
      name: `css-${index + 1}`,
      value,
      usage: "Computed CSS color",
      count
    }));
}

function mergeColors(palette: ColorToken[], cssColors: ColorToken[]) {
  const merged = new Map<string, ColorToken>();
  for (const color of [...cssColors, ...palette]) {
    const existing = merged.get(color.value);
    merged.set(color.value, {
      ...color,
      count: (existing?.count ?? 0) + (color.count ?? 1)
    });
  }

  return Array.from(merged.values())
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
    .slice(0, 12);
}

function extractTypography(elements: PageElement[]): TypographyToken[] {
  const semantic = [
    ["Hero", (element: PageElement) => ["h1"].includes(element.tag) || parseFloat(element.styles.fontSize) >= 52],
    ["Section title", (element: PageElement) => ["h2", "h3"].includes(element.tag)],
    ["Body", (element: PageElement) => element.tag === "p"],
    ["Navigation", (element: PageElement) => element.tag === "a" && element.rect.y < 220],
    ["Control", (element: PageElement) => ["button", "input", "textarea"].includes(element.tag)]
  ] as const;

  const tokens = semantic.flatMap(([role, predicate]) => {
    const match = elements.find((element) => predicate(element));
    if (!match) return [];
    return [
      {
        role,
        fontFamily: match.styles.fontFamily,
        fontSize: match.styles.fontSize,
        fontWeight: match.styles.fontWeight,
        lineHeight: match.styles.lineHeight,
        letterSpacing: match.styles.letterSpacing
      }
    ];
  });

  if (tokens.length) {
    return tokens;
  }

  return [
    {
      role: "Body",
      fontFamily: "Inter, ui-sans-serif, system-ui",
      fontSize: "16px",
      fontWeight: "400",
      lineHeight: "1.5",
      letterSpacing: "0px"
    }
  ];
}

function findHeroElement(elements: PageElement[]) {
  return [...elements]
    .filter((element) => element.text && !["nav", "header", "footer"].includes(element.tag))
    .sort((a, b) => {
      const aScore = a.rect.width * a.rect.height + parseFloat(a.styles.fontSize) * 100;
      const bScore = b.rect.width * b.rect.height + parseFloat(b.styles.fontSize) * 100;
      return bScore - aScore;
    })[0];
}

function cssColorToHex(value: string | undefined | null) {
  if (!value || value === "transparent" || value === "rgba(0, 0, 0, 0)") return null;
  if (value.startsWith("#")) return normalizeHex(value);
  const rgba = value.match(/rgba?\(([^)]+)\)/i);
  if (!rgba) return null;
  const parts = rgba[1].split(",").map((part) => part.trim());
  const alpha = parts[3] === undefined ? 1 : Number(parts[3]);
  if (alpha <= 0.05) return null;
  return rgbToHex(Number(parts[0]), Number(parts[1]), Number(parts[2]));
}

function normalizeHex(value: string) {
  const raw = value.replace("#", "");
  if (raw.length === 3) {
    return `#${raw.split("").map((char) => char + char).join("")}`.toLowerCase();
  }
  return `#${raw.slice(0, 6)}`.toLowerCase();
}

function rgbToHex(red: number, green: number, blue: number) {
  return `#${[red, green, blue]
    .map((channel) => clamp(Math.round(channel), 0, 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

function quantize(value: number) {
  return clamp(Math.round(value / 24) * 24, 0, 255);
}

function hexToRgb(hex: string) {
  const normalized = normalizeHex(hex).replace("#", "");
  return {
    red: parseInt(normalized.slice(0, 2), 16),
    green: parseInt(normalized.slice(2, 4), 16),
    blue: parseInt(normalized.slice(4, 6), 16)
  };
}

function luminance(hex: string) {
  const { red, green, blue } = hexToRgb(hex);
  const channels = [red, green, blue].map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function saturation(hex: string) {
  const { red, green, blue } = hexToRgb(hex);
  const max = Math.max(red, green, blue) / 255;
  const min = Math.min(red, green, blue) / 255;
  if (max === 0) return 0;
  return (max - min) / max;
}

function isDark(hex: string) {
  return luminance(hex) < 0.42;
}

function uniqueValues(values: string[]) {
  return Array.from(new Set(values));
}

function uniqueFilter(value: string, index: number, values: string[]) {
  return Boolean(value) && values.indexOf(value) === index;
}

function getToken(tokens: ColorToken[], name: string, fallback: string) {
  return tokens.find((token) => token.name === name)?.value ?? fallback;
}

function toComponentName(input: string) {
  const cleaned = input
    .replace(/https?:\/\//, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return `${cleaned || "Rewind"}Recreation`;
}

function escapeJsxText(value: string) {
  return value.replace(/[{}<>]/g, (character) => {
    const entities: Record<string, string> = {
      "{": "&#123;",
      "}": "&#125;",
      "<": "&lt;",
      ">": "&gt;"
    };
    return entities[character];
  });
}

function transparentColor() {
  return "rgba(0, 0, 0, 0)";
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong while analyzing the input.";
}
