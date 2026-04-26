import type { AnalysisResult } from "./types";

export interface UrlAuthOptions {
  includeCookies: boolean;
  cookieText: string;
}

export async function analyzeUrl(url: string, auth?: UrlAuthOptions): Promise<AnalysisResult> {
  const response = await fetch("/api/analyze/url", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      url,
      viewport: {
        width: 1440,
        height: 1000
      },
      auth
    })
  });

  return readResult(response);
}

export async function analyzeScreenshot(file: File): Promise<AnalysisResult> {
  const formData = new FormData();
  formData.append("screenshot", file);
  formData.append("label", file.name);

  const response = await fetch("/api/analyze/screenshot", {
    method: "POST",
    body: formData
  });

  return readResult(response);
}

async function readResult(response: Response) {
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error ?? "Analysis failed.");
  }
  return payload as AnalysisResult;
}
