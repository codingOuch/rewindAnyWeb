import {
  Braces,
  Check,
  Code2,
  Copy,
  Download,
  Figma,
  FileJson,
  Globe2,
  History,
  ImageUp,
  KeyRound,
  Layers3,
  LoaderCircle,
  Palette,
  Rows3,
} from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { analyzeScreenshot, analyzeUrl, openLoginWindow } from "./api";
import type { AnalysisResult, FigmaLayer } from "./types";

type InputMode = "url" | "screenshot";
type OutputTab = "source" | "style" | "figma" | "elements";

const outputTabs: Array<{ id: OutputTab; label: string; icon: typeof Code2 }> = [
  { id: "source", label: "Source", icon: Code2 },
  { id: "style", label: "Style", icon: Palette },
  { id: "figma", label: "Figma", icon: Figma },
  { id: "elements", label: "Elements", icon: Rows3 }
];

export default function App() {
  const [mode, setMode] = useState<InputMode>("url");
  const [url, setUrl] = useState("https://x.ai");
  const [useBrowserSession, setUseBrowserSession] = useState(false);
  const [sessionStatus, setSessionStatus] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [activeTab, setActiveTab] = useState<OutputTab>("source");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const nextResult =
        mode === "url"
          ? await analyzeUrl(url, {
              useBrowserSession
            })
          : file
            ? await analyzeScreenshot(file)
            : null;
      if (!nextResult) {
        throw new Error("Choose a screenshot first.");
      }
      setResult(nextResult);
      setActiveTab("source");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Analysis failed.");
    } finally {
      setLoading(false);
    }
  }

  async function copyText(label: string, value: string) {
    try {
      await copyToClipboard(value);
      setCopied(label);
      setToast(`${copyLabel(label)} copied`);
      window.setTimeout(() => setCopied(null), 1400);
      window.setTimeout(() => setToast(null), 1800);
    } catch {
      setToast("Copy failed");
      window.setTimeout(() => setToast(null), 1800);
    }
  }

  function download(label: string, value: string, type = "application/json") {
    const blob = new Blob([value], { type });
    const urlObject = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = urlObject;
    link.download = label;
    link.click();
    URL.revokeObjectURL(urlObject);
  }

  async function handleOpenLoginWindow() {
    setError(null);
    setSessionStatus("Opening login window...");

    try {
      const session = await openLoginWindow(url);
      setSessionStatus(session.message);
    } catch (caught) {
      setSessionStatus(null);
      setError(caught instanceof Error ? caught.message : "Could not open the login window.");
    }
  }

  const figmaJson = useMemo(() => (result ? JSON.stringify(result.figma, null, 2) : ""), [result]);

  return (
    <main className="app-shell">
      <section className="control-panel" aria-label="Input controls">
        <div className="brand-lockup">
          <div className="brand-mark">
            <History size={24} />
          </div>
          <div>
            <h1>Rewind Any Web</h1>
            <p>URL or screenshot to source, style, and Figma structure.</p>
          </div>
        </div>

        <form className="input-stack" onSubmit={handleSubmit}>
          <div className="segmented-control" role="tablist" aria-label="Input type">
            <button
              className={mode === "url" ? "active" : ""}
              type="button"
              onClick={() => setMode("url")}
            >
              <Globe2 size={16} />
              URL
            </button>
            <button
              className={mode === "screenshot" ? "active" : ""}
              type="button"
              onClick={() => setMode("screenshot")}
            >
              <ImageUp size={16} />
              Screenshot
            </button>
          </div>

          {mode === "url" ? (
            <div className="url-options">
              <label className="field">
                <span>Web page</span>
                <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://x.ai" />
              </label>

              <label className="checkbox-field">
                <input
                  checked={useBrowserSession}
                  type="checkbox"
                  onChange={(event) => setUseBrowserSession(event.target.checked)}
                />
                <span>
                  <KeyRound size={16} />
                  Use browser login state
                </span>
              </label>

              {useBrowserSession ? (
                <div className="session-card">
                  <p>
                    Tries your running Chrome over CDP first, then falls back to a local saved profile.
                  </p>
                  <button type="button" onClick={handleOpenLoginWindow}>
                    <KeyRound size={16} />
                    Open saved login window
                  </button>
                  <small>{sessionStatus ?? "For current Chrome, enable CDP on localhost:9222. Otherwise log in once here."}</small>
                </div>
              ) : null}
            </div>
          ) : (
            <label className="drop-zone">
              <ImageUp size={22} />
              <strong>{file ? file.name : "Choose screenshot"}</strong>
              <span>PNG, JPG, or WebP up to 12 MB</span>
              <input
                accept="image/png,image/jpeg,image/webp"
                type="file"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </label>
          )}

          <button className="primary-action" disabled={loading} type="submit">
            {loading ? <LoaderCircle className="spin" size={18} /> : <History size={18} />}
            {loading ? "Rewinding" : "Rewind"}
          </button>
        </form>

        {error ? <p className="status-error">{error}</p> : null}

        <div className="sample-note">
          <FileJson size={18} />
          <span>x.ai is loaded as the first sample. The API captures the live page, then generates a reconstruction package.</span>
        </div>
      </section>

      <section className="workspace" aria-label="Analysis result">
        {result ? (
          <>
            <header className="result-header">
              <div>
                <span className="eyebrow">{result.mode}</span>
                <h2>{result.title}</h2>
                <p>{result.styleGuide.summary}</p>
              </div>
              <div className="header-actions">
                <button
                  title="Copy Figma JSON"
                  type="button"
                  onClick={() => copyText("figma", figmaJson)}
                >
                  {copied === "figma" ? <Check size={16} /> : <Copy size={16} />}
                  Copy Figma
                </button>
                <button
                  title="Download full analysis"
                  type="button"
                  onClick={() => download("rewind-analysis.json", JSON.stringify(result, null, 2))}
                >
                  <Download size={16} />
                  JSON
                </button>
              </div>
            </header>

            <div className="metrics-row" aria-label="Capture metrics">
              <Metric label="Elements" value={result.metrics.visibleElements} />
              <Metric label="Colors" value={result.metrics.colorsSampled} />
              <Metric label="Links" value={result.metrics.links} />
              <Metric label="Images" value={result.metrics.images} />
            </div>

            <div className="result-layout">
              <aside className="preview-pane" aria-label="Captured preview">
                {result.screenshotDataUrl ? <img src={result.screenshotDataUrl} alt={`${result.title} screenshot`} /> : null}
                <dl>
                  <div>
                    <dt>Viewport</dt>
                    <dd>
                      {result.viewport.width} × {result.viewport.height}
                    </dd>
                  </div>
                  <div>
                    <dt>Captured</dt>
                    <dd>{new Date(result.capturedAt).toLocaleString()}</dd>
                  </div>
                </dl>
              </aside>

              <div className="output-pane">
                <nav className="tab-list" aria-label="Outputs">
                  {outputTabs.map((tab) => {
                    const Icon = tab.icon;
                    return (
                      <button
                        className={activeTab === tab.id ? "active" : ""}
                        key={tab.id}
                        type="button"
                        onClick={() => setActiveTab(tab.id)}
                      >
                        <Icon size={16} />
                        {tab.label}
                      </button>
                    );
                  })}
                </nav>

                {activeTab === "source" ? (
                  <SourcePanel
                    copied={copied}
                    onCopy={copyText}
                    result={result}
                  />
                ) : null}
                {activeTab === "style" ? <StylePanel result={result} /> : null}
                {activeTab === "figma" ? (
                  <FigmaPanel
                    copied={copied}
                    figmaJson={figmaJson}
                    onCopy={copyText}
                    onDownload={download}
                    result={result}
                  />
                ) : null}
                {activeTab === "elements" ? <ElementsPanel result={result} /> : null}
              </div>
            </div>
          </>
        ) : (
          <div className="empty-state">
            <Layers3 size={42} />
            <h2>Ready for the first rewind</h2>
            <p>Run the sample URL or upload a screenshot to generate source, style tokens, and a Figma layer tree.</p>
          </div>
        )}
      </section>
      <Toast message={toast} />
    </main>
  );
}

function copyLabel(label: string) {
  const labels: Record<string, string> = {
    css: "CSS",
    figma: "Figma JSON",
    handoff: "Handoff prompt",
    tsx: "React source"
  };
  return labels[label] ?? "Content";
}

async function copyToClipboard(value: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall through to the textarea copy path for stricter browser contexts.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);

  if (!copied) {
    throw new Error("Copy command failed.");
  }
}

function Toast({ message }: { message: string | null }) {
  if (!message) return null;

  return (
    <div className="toast" role="status" aria-live="polite">
      <Check size={16} />
      <span>{message}</span>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function SourcePanel({
  copied,
  onCopy,
  result
}: {
  copied: string | null;
  onCopy: (label: string, value: string) => void;
  result: AnalysisResult;
}) {
  return (
    <div className="panel-stack">
      <CodeBlock
        actionLabel={copied === "tsx" ? "Copied" : "Copy"}
        icon={copied === "tsx" ? Check : Copy}
        label={`${result.source.componentName}.tsx`}
        onAction={() => onCopy("tsx", result.source.tsx)}
        value={result.source.tsx}
      />
      <CodeBlock
        actionLabel={copied === "css" ? "Copied" : "Copy"}
        icon={copied === "css" ? Check : Copy}
        label={`${result.source.componentName}.css`}
        onAction={() => onCopy("css", result.source.css)}
        value={result.source.css}
      />
      <ul className="note-list">
        {result.source.notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </div>
  );
}

function StylePanel({ result }: { result: AnalysisResult }) {
  return (
    <div className="panel-stack">
      <section className="token-section">
        <h3>Colors</h3>
        <div className="swatch-grid">
          {result.styleGuide.colors.map((color) => (
            <div className="swatch" key={`${color.name}-${color.value}`}>
              <i style={{ background: color.value }} />
              <strong>{color.name}</strong>
              <span>{color.value}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="token-section">
        <h3>Typography</h3>
        <div className="type-list">
          {result.styleGuide.typography.map((type) => (
            <div key={type.role}>
              <strong>{type.role}</strong>
              <span>{type.fontSize} · {type.fontWeight} · {type.lineHeight}</span>
              <small>{type.fontFamily}</small>
            </div>
          ))}
        </div>
      </section>

      <section className="token-section two-column">
        <div>
          <h3>Radii</h3>
          <div className="chip-row">
            {result.styleGuide.radii.map((radius) => (
              <span key={radius}>{radius}</span>
            ))}
          </div>
        </div>
        <div>
          <h3>Effects</h3>
          <ul className="note-list">
            {result.styleGuide.effects.map((effect) => (
              <li key={effect}>{effect}</li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}

function FigmaPanel({
  copied,
  figmaJson,
  onCopy,
  onDownload,
  result
}: {
  copied: string | null;
  figmaJson: string;
  onCopy: (label: string, value: string) => void;
  onDownload: (label: string, value: string, type?: string) => void;
  result: AnalysisResult;
}) {
  return (
    <div className="panel-stack">
      <CodeBlock
        actionLabel={copied === "handoff" ? "Copied" : "Copy"}
        icon={copied === "handoff" ? Check : Copy}
        label="figma-developer-handoff.md"
        onAction={() => onCopy("handoff", result.figma.handoffPrompt)}
        value={result.figma.handoffPrompt}
      />
      <div className="figma-grid">
        <section className="layer-tree">
          <h3>Layer tree</h3>
          {result.figma.layers.map((layer) => (
            <LayerNode key={layer.id} layer={layer} />
          ))}
        </section>
        <section className="json-panel">
          <div className="code-head">
            <strong>figma-export.json</strong>
            <div>
              <button type="button" onClick={() => onCopy("figma", figmaJson)}>
                <Copy size={16} />
                Copy
              </button>
              <button type="button" onClick={() => onDownload("figma-export.json", figmaJson)}>
                <Download size={16} />
                Export
              </button>
            </div>
          </div>
          <pre>{figmaJson}</pre>
        </section>
      </div>
    </div>
  );
}

function ElementsPanel({ result }: { result: AnalysisResult }) {
  return (
    <div className="element-table-wrap">
      <table className="element-table">
        <thead>
          <tr>
            <th>Tag</th>
            <th>Text</th>
            <th>Bounds</th>
            <th>Font</th>
          </tr>
        </thead>
        <tbody>
          {result.elements.slice(0, 90).map((element) => (
            <tr key={element.id}>
              <td>{element.tag}</td>
              <td>{element.text || element.placeholder || "visual"}</td>
              <td>
                {element.rect.x}, {element.rect.y}, {element.rect.width} × {element.rect.height}
              </td>
              <td>
                {element.styles.fontSize} / {element.styles.fontWeight}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CodeBlock({
  actionLabel,
  icon: Icon,
  label,
  onAction,
  value
}: {
  actionLabel: string;
  icon: typeof Copy;
  label: string;
  onAction: () => void;
  value: string;
}) {
  return (
    <section className="code-block">
      <div className="code-head">
        <strong>{label}</strong>
        <button type="button" onClick={onAction}>
          <Icon size={16} />
          {actionLabel}
        </button>
      </div>
      <pre>{value}</pre>
    </section>
  );
}

function LayerNode({ layer }: { layer: FigmaLayer }) {
  return (
    <details open>
      <summary>
        <Braces size={14} />
        <span>{layer.name}</span>
        <small>{layer.type}</small>
      </summary>
      {layer.children?.length ? (
        <div className="layer-children">
          {layer.children.slice(0, 60).map((child) => (
            <LayerNode key={child.id} layer={child} />
          ))}
        </div>
      ) : null}
    </details>
  );
}
