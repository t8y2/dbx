import { createRunStatementButtonDom } from "@/lib/editor/editorThemes";
import type { StatementExecutionMarkerStatus } from "@/lib/tabs/tabPresentation";

export interface StatementGutterMarkerDomOptions {
  canExecute: boolean;
  executeLabel: string;
  status?: StatementExecutionMarkerStatus;
  statusLabel?: string;
}

export function shouldShowStatementGutter(showRunButtons: boolean, markerCount: number): boolean {
  return showRunButtons || markerCount > 0;
}

function createStatusIconDom(status: StatementExecutionMarkerStatus, includeCircle: boolean) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", includeCircle ? "2" : "3.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");

  if (includeCircle) {
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", "12");
    circle.setAttribute("cy", "12");
    circle.setAttribute("r", "10");
    svg.appendChild(circle);
  }

  const mark = document.createElementNS("http://www.w3.org/2000/svg", "path");
  mark.setAttribute("d", status === "error" ? "m16 8-8 8m0-8 8 8" : "m7 12 3 3 7-7");
  svg.appendChild(mark);
  return svg;
}

export function createStatementGutterMarkerDom(options: StatementGutterMarkerDomOptions): HTMLElement {
  const statusLabel = options.statusLabel?.trim();
  if (options.canExecute) {
    const button = createRunStatementButtonDom(options.executeLabel);
    if (!options.status) return button;

    const badge = document.createElement("span");
    badge.className = `cm-statement-execution-badge cm-statement-execution-badge--${options.status}`;
    badge.setAttribute("aria-hidden", "true");
    badge.appendChild(createStatusIconDom(options.status, false));
    button.appendChild(badge);

    if (statusLabel) {
      const label = `${options.executeLabel}. ${statusLabel}`;
      button.title = label;
      button.setAttribute("aria-label", label);
    }
    return button;
  }

  const marker = document.createElement("span");
  marker.className = `cm-statement-execution-marker cm-statement-execution-marker--${options.status}`;
  if (statusLabel) {
    marker.title = statusLabel;
    marker.setAttribute("aria-label", statusLabel);
  }
  if (options.status) marker.appendChild(createStatusIconDom(options.status, true));
  return marker;
}
