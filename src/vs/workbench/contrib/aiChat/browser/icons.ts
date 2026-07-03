export const AI_ICONS = {
  model: 'codicon-robot',
  statusOnline: 'codicon-circle-filled',
  file: 'codicon-file-code',
  chevronRight: 'codicon-chevron-right',
  send: 'codicon-send',
  attach: 'codicon-link',
  apply: 'codicon-check',
  reject: 'codicon-close',
  openExternal: 'codicon-link-external',
  planPending: 'codicon-circle-outline',
  planInProgress: 'codicon-sync~spin',
  planCompleted: 'codicon-check',
  planFailed: 'codicon-error',
  timelineThought: 'codicon-comment',
  timelineToolUse: 'codicon-tools',
  timelineToolResult: 'codicon-output',
  timelineError: 'codicon-error',
  timelinePlan: 'codicon-symbol-ruler',
  commandKey: 'codicon-server-process',
} as const;

export type AIIcon = keyof typeof AI_ICONS;

export function renderIcon(icon: AIIcon, className?: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = `codicon ${AI_ICONS[icon]}`;
  if (className) span.classList.add(className);
  return span;
}
