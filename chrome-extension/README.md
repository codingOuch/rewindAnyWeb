# Rewind Any Web Chrome Extension

Generate a frontend and Figma prompt from the current authenticated tab.

## Install locally

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this `chrome-extension` folder.

## Use

1. Open the page you want to rewind.
2. Click the Rewind Any Web extension.
3. Click **Generate + Copy Prompt**.
4. Paste the prompt into your AI coding or design workflow.

The extension uses `activeTab`, `scripting`, and `captureVisibleTab` so it works from the current tab context. It does not read or export browser cookies.
