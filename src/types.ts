export type AnalysisMode = "url" | "screenshot";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageElement {
  id: string;
  tag: string;
  role: string | null;
  text: string;
  href?: string | null;
  src?: string | null;
  placeholder?: string | null;
  rect: Rect;
  styles: {
    color: string;
    backgroundColor: string;
    borderColor: string;
    borderRadius: string;
    boxShadow: string;
    fontFamily: string;
    fontSize: string;
    fontWeight: string;
    letterSpacing: string;
    lineHeight: string;
    opacity: string;
    textTransform: string;
    backdropFilter: string;
    backgroundImage: string;
  };
}

export interface ColorToken {
  name: string;
  value: string;
  usage: string;
  count?: number;
}

export interface TypographyToken {
  role: string;
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  letterSpacing: string;
}

export interface StyleGuide {
  summary: string;
  colors: ColorToken[];
  typography: TypographyToken[];
  radii: string[];
  spacing: string[];
  effects: string[];
  notes: string[];
}

export interface GeneratedSource {
  framework: "React";
  componentName: string;
  tsx: string;
  css: string;
  notes: string[];
}

export interface FigmaLayer {
  id: string;
  type: "FRAME" | "GROUP" | "TEXT" | "RECTANGLE" | "ROUNDED_RECT" | "IMAGE";
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity?: number;
  fills?: string[];
  strokes?: string[];
  cornerRadius?: number;
  text?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string;
  children?: FigmaLayer[];
  imageDataUrl?: string;
}

export interface FigmaExport {
  name: string;
  viewport: {
    width: number;
    height: number;
  };
  tokens: {
    colors: ColorToken[];
    typography: TypographyToken[];
    radii: string[];
  };
  layers: FigmaLayer[];
  pluginInstructions: string[];
  handoffPrompt: string;
}

export interface AnalysisResult {
  id: string;
  mode: AnalysisMode;
  input: string;
  title: string;
  capturedAt: string;
  viewport: {
    width: number;
    height: number;
  };
  screenshotDataUrl?: string;
  elements: PageElement[];
  styleGuide: StyleGuide;
  source: GeneratedSource;
  figma: FigmaExport;
  metrics: {
    visibleElements: number;
    colorsSampled: number;
    links: number;
    buttons: number;
    images: number;
  };
}
