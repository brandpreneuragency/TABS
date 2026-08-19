// Catalog of the design-token CSS variables surfaced in Settings → Appearance.
// Grouped by prefix-based categories. Token *defaults* come from the CSS
// (`src/index.css` + `src/styles/tokens.css`); this file only declares which
// tokens are editable and what editor to use for each.

export type TokenEditorType = 'color' | 'text' | 'font';

export interface TokenDescriptor {
  name: string;
  label: string;
  type: TokenEditorType;
}

export interface TokenCategory {
  id: string;
  label: string;
  hint: string;
  tokens: TokenDescriptor[];
}

export const THEME_TOKEN_CATEGORIES: TokenCategory[] = [
  {
    id: 'font',
    label: 'Text & Font',
    hint: 'Font family, font sizes and line heights.',
    tokens: [
      { name: '--c-font-1', label: 'Font family', type: 'font' },
      { name: '--fs-xs', label: 'Font size — xs', type: 'text' },
      { name: '--fs-sm', label: 'Font size — sm', type: 'text' },
      { name: '--fs-base', label: 'Font size — base', type: 'text' },
      { name: '--lh-xs', label: 'Line height — xs', type: 'text' },
      { name: '--lh-sm', label: 'Line height — sm', type: 'text' },
      { name: '--lh-base', label: 'Line height — base', type: 'text' },
      { name: '--font-fluid-12', label: 'Fluid font 12', type: 'text' },
      { name: '--font-fluid-14', label: 'Fluid font 14', type: 'text' },
      { name: '--font-fluid-16', label: 'Fluid font 16', type: 'text' },
      { name: '--font-fluid-18', label: 'Fluid font 18', type: 'text' },
      { name: '--line-tight', label: 'Line height — tight', type: 'text' },
      { name: '--line-normal', label: 'Line height — normal', type: 'text' },
      { name: '--line-relaxed', label: 'Line height — relaxed', type: 'text' },
    ],
  },
  {
    id: 'color',
    label: 'Color',
    hint: 'Background, text, border, accent and status colors.',
    tokens: [
      { name: '--c-background-1', label: 'Background 1', type: 'color' },
      { name: '--c-background-2', label: 'Background 2', type: 'color' },
      { name: '--c-background-3', label: 'Background 3', type: 'color' },
      { name: '--c-background-4', label: 'Background 4', type: 'color' },
      { name: '--c-text-1', label: 'Text 1', type: 'color' },
      { name: '--c-text-2', label: 'Text 2', type: 'color' },
      { name: '--c-text-3', label: 'Text 3', type: 'color' },
      { name: '--c-border-1', label: 'Border 1', type: 'color' },
      { name: '--c-border-2', label: 'Border 2', type: 'color' },
      { name: '--c-accent-center-panel', label: 'Accent — center panel', type: 'color' },
      { name: '--c-accent-2', label: 'Accent 2', type: 'color' },
      { name: '--c-accent-3', label: 'Accent 3', type: 'color' },
      { name: '--c-danger', label: 'Danger', type: 'color' },
      { name: '--c-warning', label: 'Warning', type: 'color' },
      { name: '--c-success', label: 'Success', type: 'color' },
      { name: '--c-info', label: 'Info', type: 'color' },
      { name: '--c-overlay', label: 'Overlay', type: 'color' },
    ],
  },
  {
    id: 'spacing',
    label: 'Spacing',
    hint: 'Spacing scale (rem).',
    tokens: [
      { name: '--space-0', label: 'space-0', type: 'text' },
      { name: '--space-1', label: 'space-1', type: 'text' },
      { name: '--space-2', label: 'space-2', type: 'text' },
      { name: '--space-3', label: 'space-3', type: 'text' },
      { name: '--space-4', label: 'space-4', type: 'text' },
      { name: '--space-5', label: 'space-5', type: 'text' },
      { name: '--space-6', label: 'space-6', type: 'text' },
      { name: '--space-7', label: 'space-7', type: 'text' },
      { name: '--space-8', label: 'space-8', type: 'text' },
      { name: '--space-9', label: 'space-9', type: 'text' },
      { name: '--space-10', label: 'space-10', type: 'text' },
      { name: '--space-11', label: 'space-11', type: 'text' },
      { name: '--space-12', label: 'space-12', type: 'text' },
      { name: '--space-fluid-sm', label: 'space-fluid-sm', type: 'text' },
      { name: '--space-fluid-md', label: 'space-fluid-md', type: 'text' },
      { name: '--space-fluid-lg', label: 'space-fluid-lg', type: 'text' },
    ],
  },
  {
    id: 'radius',
    label: 'Radius',
    hint: 'Corner radius scale (px).',
    tokens: [
      { name: '--radius-xs', label: 'radius-xs', type: 'text' },
      { name: '--radius-sm', label: 'radius-sm', type: 'text' },
      { name: '--radius-md', label: 'radius-md', type: 'text' },
      { name: '--radius-lg', label: 'radius-lg', type: 'text' },
      { name: '--radius-xl', label: 'radius-xl', type: 'text' },
      { name: '--radius-2xl', label: 'radius-2xl', type: 'text' },
      { name: '--radius-full', label: 'radius-full', type: 'text' },
    ],
  },
];

export const THEME_FONT_OPTIONS = [
  'Inter, system-ui, sans-serif',
  'ui-sans-serif, system-ui, sans-serif',
  'ui-monospace, SFMono-Regular, Menlo, monospace',
  'Georgia, "Times New Roman", serif',
  '"Courier New", monospace',
  'Verdana, sans-serif',
];
