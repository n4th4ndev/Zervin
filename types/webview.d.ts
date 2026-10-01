import type { DetailedHTMLProps, HTMLAttributes } from "react";

// Electron <webview> used by the Preview tile inside the desktop shell.
export type WebviewElement = HTMLElement & {
  src: string;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  stop: () => void;
  getURL: () => string;
  getTitle: () => string;
  getWebContentsId: () => number;
  executeJavaScript: (script: string, userGesture?: boolean) => Promise<unknown>;
  openDevTools: () => void;
};

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<HTMLElement> & { src?: string; allowpopups?: boolean; partition?: string; useragent?: string }, HTMLElement>;
    }
  }
}
