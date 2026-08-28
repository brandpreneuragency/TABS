import { useMemo, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { useThemeStore, getTokenDisplayValue } from '../../stores/themeStore';
import { useUIStore } from '../../stores/uiStore';
import { THEME_TOKEN_CATEGORIES, THEME_FONT_OPTIONS, type TokenCategory, type TokenDescriptor } from './themeTokenCatalog';
import { SettingsContent } from './GeneralSettingsContent';
import { SettingsPanels } from './SettingsPanels';
import { EDITOR_FONT_SIZES } from '../../stores/editorFontSize';

const GENERAL_CATEGORY_ID = 'general';

const isHex = (v: string) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim());

export function AppearanceSection() {
  const tokens = useThemeStore((s) => s.tokens);
  const setToken = useThemeStore((s) => s.setToken);
  const resetToken = useThemeStore((s) => s.resetToken);
  const resetAll = useThemeStore((s) => s.resetAll);
  const { editorFontFamily, editorFontSize, setEditorFontFamily, setEditorFontSize } = useUIStore();

  const [activeCategory, setActiveCategory] = useState<string>(GENERAL_CATEGORY_ID);

  const categories: TokenCategory[] = useMemo(
    () => [{ id: GENERAL_CATEGORY_ID, label: 'General', hint: 'Text size, font, language & default workspace folder.', tokens: [] }, ...THEME_TOKEN_CATEGORIES],
    [],
  );
  const active = categories.find((c) => c.id === activeCategory) ?? categories[0];

  const leftMain = (
    <div className="settings-list-body">
      {categories.map((c) => (
        <button
          key={c.id}
          className={`settings-list-item${activeCategory === c.id ? ' settings-list-item--active' : ''}`}
          onClick={() => setActiveCategory(c.id)}
        >
          <span className="settings-list-item-title">{c.label}</span>
        </button>
      ))}
    </div>
  );

  const centerMain = (
    <div className="settings-detail-body">
      {active.id === GENERAL_CATEGORY_ID && (
        <>
          <SettingsContent />
          <div>
            <label className="semibold" style={{ display: 'block', fontSize: 'var(--fs-base)', color: 'var(--c-text-2)', marginBottom: 8 }}>Editor font</label>
            <div className="row gap-3" style={{ gap: 12, alignItems: 'flex-end' }}>
              <div style={{ flex: 1 }}>
                <select className="ctrl w-full" style={{ fontSize: 'var(--fs-base)' }} value={editorFontFamily} onChange={(e) => setEditorFontFamily(e.target.value)}>
                  {['Inter', 'Arial', 'Times New Roman', 'Georgia', 'Courier New'].map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>
              <div className="settings-scope-toggle">
                {EDITOR_FONT_SIZES.map((sz) => (
                  <button key={sz} className={editorFontSize === sz ? 'is-active' : ''} onClick={() => setEditorFontSize(sz)}>{sz}px</button>
                ))}
              </div>
            </div>
          </div>
          <div>
            <button className="btn" style={{ fontSize: 'var(--fs-base)' }} onClick={() => resetAll()}>
              <RotateCcw size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} /> Reset all token overrides
            </button>
            <p className="subtle" style={{ fontSize: 'var(--fs-base)', marginTop: 6 }}>
              {Object.keys(tokens).length} override(s) active. Defaults come from the CSS.
            </p>
          </div>
        </>
      )}

      {active.id !== GENERAL_CATEGORY_ID && (
        <>
          <p className="subtle" style={{ fontSize: 'var(--fs-base)', margin: '0 0 4px' }}>{active.hint}</p>
          {active.tokens.map((tok) => (
            <TokenRow
              key={tok.name}
              token={tok}
              overridden={Object.prototype.hasOwnProperty.call(tokens, tok.name)}
              onSet={(v) => setToken(tok.name, v)}
              onReset={() => resetToken(tok.name)}
            />
          ))}
        </>
      )}
    </div>
  );

  return (
    <SettingsPanels
      leftMain={leftMain}
      centerMain={centerMain}
    />
  );
}

function TokenRow({ token, overridden, onSet, onReset }: {
  token: TokenDescriptor;
  overridden: boolean;
  onSet: (v: string) => void;
  onReset: () => void;
}) {
  const current = getTokenDisplayValue(token.name);
  const hex = isHex(current);

  return (
    <div className="settings-token-row">
      <div className="settings-token-label">
        <span className="settings-token-name">{token.label}</span>
        <span className="settings-token-current">{token.name}{current ? ` · ${current}` : ''}</span>
      </div>

      {token.type === 'color' && hex && (
        <input
          type="color"
          className="settings-token-swatch"
          style={{ padding: 0 }}
          value={current}
          onChange={(e) => onSet(e.target.value)}
          title="Pick color"
        />
      )}

      {token.type === 'font' ? (
        <select
          className="ctrl settings-token-input"
          style={{ fontSize: 'var(--fs-base)' }}
          value={overridden ? current : ''}
          onChange={(e) => onSet(e.target.value)}
        >
          <option value="">— default —</option>
          {THEME_FONT_OPTIONS.map((f) => <option key={f} value={f}>{f.split(',')[0]}</option>)}
        </select>
      ) : (
        <input
          className="ctrl settings-token-input"
          style={{ fontSize: 'var(--fs-base)' }}
          defaultValue={overridden ? current : ''}
          placeholder={current || '—'}
          onBlur={(e) => onSet(e.target.value)}
        />
      )}

      {overridden && (
        <button className="settings-token-reset" onClick={onReset} title="Reset to default">Reset</button>
      )}
    </div>
  );
}
