const els = {
  copyButton: document.getElementById("copyButton"),
  colorCount: document.getElementById("colorCount"),
  downloadButton: document.getElementById("downloadButton"),
  elementCount: document.getElementById("elementCount"),
  fontCount: document.getElementById("fontCount"),
  generateButton: document.getElementById("generateButton"),
  metrics: document.getElementById("metrics"),
  pageTitle: document.getElementById("pageTitle"),
  pageUrl: document.getElementById("pageUrl"),
  promptOutput: document.getElementById("promptOutput"),
  screenshot: document.getElementById("screenshot"),
  toast: document.getElementById("toast")
};

let currentPrompt = "";
let currentTab = null;

init();

async function init() {
  currentTab = await getCurrentTab();
  els.pageTitle.textContent = currentTab?.title || "Current tab";
  els.pageUrl.textContent = currentTab?.url || "";
  els.generateButton.addEventListener("click", generatePrompt);
  els.copyButton.addEventListener("click", () => copyPrompt(currentPrompt));
  els.downloadButton.addEventListener("click", downloadPrompt);
}

async function generatePrompt() {
  if (!currentTab?.id) {
    showToast("No active tab found");
    return;
  }

  setBusy(true);

  try {
    const [modelResult] = await chrome.scripting.executeScript({
      target: { tabId: currentTab.id },
      func: collectRewindPageModel
    });
    const model = modelResult.result;
    const screenshotDataUrl = await chrome.tabs.captureVisibleTab(currentTab.windowId, {
      format: "png"
    });
    const screenshotPalette = await paletteFromScreenshot(screenshotDataUrl);
    currentPrompt = buildPrompt(model, screenshotPalette);

    els.promptOutput.value = currentPrompt;
    els.elementCount.textContent = String(model.elements.length);
    els.colorCount.textContent = String(model.styleGuide.colors.length);
    els.fontCount.textContent = String(model.styleGuide.typography.length);
    els.metrics.hidden = false;
    els.screenshot.src = screenshotDataUrl;
    els.screenshot.hidden = false;
    els.copyButton.disabled = false;
    els.downloadButton.disabled = false;
    await copyPrompt(currentPrompt);
  } catch (error) {
    console.error(error);
    showToast(error?.message || "Could not generate prompt");
  } finally {
    setBusy(false);
  }
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function setBusy(isBusy) {
  els.generateButton.disabled = isBusy;
  els.generateButton.querySelector("span").textContent = isBusy ? "Rewinding..." : "Generate + Copy Prompt";
}

async function copyPrompt(prompt) {
  if (!prompt) return;
  await navigator.clipboard.writeText(prompt);
  showToast("Prompt copied");
}

function downloadPrompt() {
  if (!currentPrompt) return;
  const blob = new Blob([currentPrompt], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "rewind-current-page-prompt.md";
  link.click();
  URL.revokeObjectURL(url);
  showToast("Prompt downloaded");
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    els.toast.hidden = true;
  }, 1800);
}

async function paletteFromScreenshot(dataUrl) {
  const image = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  const size = 96;
  canvas.width = size;
  canvas.height = Math.max(1, Math.round((image.height / image.width) * size));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const buckets = new Map();

  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3] < 24) continue;
    const key = rgbToHex(quantize(pixels[index]), quantize(pixels[index + 1]), quantize(pixels[index + 2]));
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }

  return Array.from(buckets.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([value, count], index) => ({
      name: index === 0 ? "screenshot-canvas" : `screenshot-${index}`,
      value,
      count
    }));
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

function buildPrompt(model, screenshotPalette) {
  const navItems = model.elements
    .filter((element) => element.tag === "a" && element.rect.y < 220 && element.text)
    .map((element) => element.text)
    .filter(unique)
    .slice(0, 12);
  const controls = model.elements
    .filter((element) => ["button", "input", "textarea"].includes(element.tag) || element.role === "button")
    .map((element) => element.text || element.placeholder || element.tag)
    .filter(unique)
    .slice(0, 8);
  const content = model.elements
    .filter((element) => ["h1", "h2", "h3", "p"].includes(element.tag) && element.text)
    .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height)
    .map((element) => `${element.tag.toUpperCase()}: ${element.text}`)
    .filter(unique)
    .slice(0, 12);
  const colors = mergeColors(model.styleGuide.colors, screenshotPalette).slice(0, 10);

  return `You are a senior product designer and frontend engineer. Generate a Figma-ready design plan and implementation prompt from this captured web page.

Goal:
- Create a new page in the same visual language as the captured page.
- Do not clone trademarks, private content, or proprietary copy verbatim.
- Extract reusable style grammar: layout, typography, color, spacing, controls, imagery, motion, and component anatomy.

Captured page:
- Title: ${model.title || "Untitled"}
- URL: ${model.url}
- Viewport: ${model.viewport.width} x ${model.viewport.height}
- Visible elements sampled: ${model.elements.length}
- Capture mode: Chrome extension, current authenticated tab context.

Visual style summary:
${model.styleGuide.summary}

Color tokens:
${colors.map((color) => `- ${color.name}: ${color.value}`).join("\n")}

Typography tokens:
${model.styleGuide.typography
  .map((type) => `- ${type.role}: ${type.fontSize}, weight ${type.fontWeight}, line ${type.lineHeight}, tracking ${type.letterSpacing}, family ${type.fontFamily}`)
  .join("\n")}

Layout and components:
- Navigation: ${navItems.length ? navItems.join(", ") : "No clear navigation captured"}
- Controls: ${controls.length ? controls.join(", ") : "No clear controls captured"}
- Radii: ${model.styleGuide.radii.join(", ")}
- Effects: ${model.styleGuide.effects.join("; ")}
- Spacing scale to reuse: 4, 8, 12, 16, 24, 32, 48, 72, 96

Prominent captured content structure:
${content.length ? content.map((item) => `- ${item}`).join("\n") : "- Use captured layout evidence rather than exact copy."}

Figma deliverable:
- Create local color styles, text styles, effect styles, and radius variables first.
- Build reusable components for nav item, primary action, secondary action, input/prompt surface, content card, media/hero treatment, and announcement/content band when applicable.
- Include default, hover, focused, disabled, and emphasized states where relevant.
- Compose one desktop frame and one mobile frame using the same components.
- Keep the first viewport focused on the main product/brand signal and let the next section peek below the fold.

Frontend deliverable:
- Generate React + CSS or HTML + CSS using semantic structure.
- Use CSS custom properties for every token.
- Preserve responsive behavior, accessible labels, focus states, and reduced-motion-safe animation.
- Make the output production-readable rather than a screenshot trace.

Important fidelity notes:
- Match the visual rhythm, density, contrast, typography hierarchy, and component behavior.
- Use the screenshot palette as evidence, but prefer clean token names.
- The current tab may contain authenticated state; do not expose secrets, account names, or private data in generated copy.`;
}

function collectRewindPageModel() {
  const viewport = {
    width: window.innerWidth,
    height: window.innerHeight
  };
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

  const cleanText = (text) => (text || "").replace(/\s+/g, " ").trim().slice(0, 180);
  const visible = (element, rect, styles) => {
    if (rect.width < 2 || rect.height < 2) return false;
    if (Number(styles.opacity) < 0.05 || styles.visibility === "hidden" || styles.display === "none") return false;
    if (rect.bottom < -viewport.height * 0.5 || rect.top > viewport.height * 2.5) return false;
    if (rect.right < -viewport.width * 0.5 || rect.left > viewport.width * 1.5) return false;
    return element.getClientRects().length > 0;
  };
  const keep = (element, tag, text, styles) => {
    const role = element.getAttribute("role");
    const hasVisualBackground = styles.backgroundImage !== "none" || styles.backgroundColor !== "rgba(0, 0, 0, 0)";
    return importantTags.has(tag) || Boolean(text) || Boolean(role) || hasVisualBackground;
  };

  const elements = Array.from(document.querySelectorAll("body *"))
    .flatMap((element, index) => {
      const tag = element.tagName.toLowerCase();
      const rect = element.getBoundingClientRect();
      const styles = window.getComputedStyle(element);
      const text = cleanText(
        tag === "input" || tag === "textarea"
          ? element.placeholder
          : element.innerText || element.textContent
      );

      if (!visible(element, rect, styles) || !keep(element, tag, text, styles)) {
        return [];
      }

      return [
        {
          id: `node-${index}`,
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
        }
      ];
    })
    .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
    .slice(0, 160);

  return {
    title: document.title,
    url: location.href,
    viewport,
    elements,
    styleGuide: buildStyleGuide(elements, document.title)
  };

  function buildStyleGuide(pageElements, title) {
    const colors = collectColors(pageElements);
    const typography = collectTypography(pageElements);
    const radii = uniqueValues(pageElements.map((element) => element.styles.borderRadius).filter(Boolean))
      .filter((value) => value !== "0px")
      .slice(0, 8);
    const effects = uniqueValues(
      pageElements.flatMap((element) => [
        element.styles.boxShadow !== "none" ? element.styles.boxShadow : "",
        element.styles.backdropFilter !== "none" ? element.styles.backdropFilter : "",
        element.styles.backgroundImage !== "none" ? "image or gradient background" : ""
      ])
    )
      .filter(Boolean)
      .slice(0, 8);
    const sorted = [...colors].sort((a, b) => luminance(a.value) - luminance(b.value));
    const darkest = sorted[0]?.value || "#050505";
    const lightest = sorted.at(-1)?.value || "#ffffff";

    return {
      summary: `${title || "Current page"} reads as a ${luminance(darkest) < 0.42 ? "dark" : "light"} interface with ${colors.length} color tokens and ${typography.length} typography roles.`,
      colors,
      typography,
      radii: radii.length ? radii : ["8px", "16px", "999px"],
      effects: effects.length ? effects : ["subtle border", "soft shadow", "viewport-scale background treatment"]
    };
  }

  function collectColors(pageElements) {
    const counts = new Map();
    for (const element of pageElements) {
      for (const value of [element.styles.color, element.styles.backgroundColor, element.styles.borderColor]) {
        const hex = cssColorToHex(value);
        if (!hex) continue;
        counts.set(hex, (counts.get(hex) || 0) + 1);
      }
    }

    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([value, count], index) => ({
        name: index === 0 ? "foreground-or-surface" : `token-${index}`,
        value,
        count
      }));
  }

  function collectTypography(pageElements) {
    const semantic = [
      ["Hero", (element) => element.tag === "h1" || parseFloat(element.styles.fontSize) >= 48],
      ["Section title", (element) => element.tag === "h2" || element.tag === "h3"],
      ["Body", (element) => element.tag === "p"],
      ["Navigation", (element) => element.tag === "a" && element.rect.y < 220],
      ["Control", (element) => ["button", "input", "textarea"].includes(element.tag)]
    ];

    return semantic.flatMap(([role, predicate]) => {
      const match = pageElements.find(predicate);
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
  }

  function cssColorToHex(value) {
    if (!value || value === "transparent" || value === "rgba(0, 0, 0, 0)") return null;
    if (value.startsWith("#")) return normalizeHex(value);
    const rgba = value.match(/rgba?\(([^)]+)\)/i);
    if (!rgba) return null;
    const parts = rgba[1].split(",").map((part) => part.trim());
    const alpha = parts[3] === undefined ? 1 : Number(parts[3]);
    if (alpha <= 0.05) return null;
    return rgbToHex(Number(parts[0]), Number(parts[1]), Number(parts[2]));
  }

  function normalizeHex(value) {
    const raw = value.replace("#", "");
    if (raw.length === 3) {
      return `#${raw.split("").map((char) => char + char).join("")}`.toLowerCase();
    }
    return `#${raw.slice(0, 6)}`.toLowerCase();
  }

  function rgbToHex(red, green, blue) {
    return `#${[red, green, blue]
      .map((channel) => Math.min(Math.max(Math.round(channel), 0), 255).toString(16).padStart(2, "0"))
      .join("")}`;
  }

  function luminance(hex) {
    const normalized = normalizeHex(hex).replace("#", "");
    const red = parseInt(normalized.slice(0, 2), 16);
    const green = parseInt(normalized.slice(2, 4), 16);
    const blue = parseInt(normalized.slice(4, 6), 16);
    const channels = [red, green, blue].map((channel) => {
      const value = channel / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }

  function uniqueValues(values) {
    return Array.from(new Set(values));
  }
}

function mergeColors(...groups) {
  const seen = new Set();
  return groups.flat().filter((color) => {
    if (!color?.value || seen.has(color.value)) return false;
    seen.add(color.value);
    return true;
  });
}

function quantize(value) {
  return Math.min(Math.max(Math.round(value / 24) * 24, 0), 255);
}

function rgbToHex(red, green, blue) {
  return `#${[red, green, blue]
    .map((channel) => Math.min(Math.max(Math.round(channel), 0), 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

function unique(value, index, values) {
  return Boolean(value) && values.indexOf(value) === index;
}
