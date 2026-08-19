// General appearance settings (text size, app font family, language, default folder) extracted
// from the (now removed) SettingsModal so both PageTemplatePage (page mode) and
// the new Settings → Appearance sub-tab can reuse it without a modal wrapper.

import { useState, useRef, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../stores/uiStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { isNativeFsAvailable, openFolderDialog } from '../../services/fs-adapter';

const FONT_FAMILIES = ['Inter', 'Georgia', 'Arial', 'Verdana', 'Trebuchet MS'];

export function SettingsContent() {
  const { t } = useTranslation();
  const {
    editorFontFamily, setEditorFontFamily,
    editorFontSize, setEditorFontSize,
    language, setLanguage,
  } = useUIStore();
  const defaultFolderPath = useWorkspaceStore((s) => s.defaultFolderPath);
  const setDefaultFolderPath = useWorkspaceStore((s) => s.setDefaultFolderPath);

  const [fontOpen, setFontOpen] = useState(false);
  const [pickingFolder, setPickingFolder] = useState(false);
  const fontRef = useRef<HTMLDivElement>(null);
  const canPickFolder = isNativeFsAvailable();

  const handleChooseDefaultFolder = async () => {
    if (!canPickFolder || pickingFolder) return;
    setPickingFolder(true);
    try {
      const picked = await openFolderDialog();
      if (picked) await setDefaultFolderPath(picked);
    } finally {
      setPickingFolder(false);
    }
  };

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (fontRef.current && !fontRef.current.contains(e.target as Node)) setFontOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div className="settings-general-content flex-col h-full w-full" style={{ background: 'var(--c-background-1)', overflow: 'hidden', display: 'flex' }}>
      <div className="settings-general-content__body flex-1 col gap-4" style={{ padding: '0px 0px 16px 0px', overflowY: 'auto' }}>
        <div>
          <div style={{ marginBottom: 12 }}>
            <div className="row" style={{ justifyContent: 'space-between', padding: '2px 0' }}>
              <label className="subtle" style={{ fontSize: 'var(--fs-base)' }}>{t('settings.textSize')}</label>
              <div className="row-xs" style={{ border: '1px solid var(--c-border-1)', borderRadius: 9999, padding: '2px 4px' }}>
                <button
                  type="button"
                  disabled={editorFontSize <= 12}
                  onClick={() => setEditorFontSize((editorFontSize - 2) as 12 | 14 | 16)}
                  className="btn-icon"
                  style={{ width: 'var(--control-height-sm)', height: 'var(--control-height-sm)', borderRadius: 9999, fontSize: 'var(--fs-base)', lineHeight: 1, opacity: editorFontSize <= 12 ? 0.3 : 1, cursor: editorFontSize <= 12 ? 'not-allowed' : 'pointer' }}
                >
                  −
                </button>
                <span className="nowrap" style={{ fontSize: 'var(--fs-base)', color: 'var(--c-text-1)', width: 32, textAlign: 'center' }}>{editorFontSize}px</span>
                <button
                  type="button"
                  disabled={editorFontSize >= 16}
                  onClick={() => setEditorFontSize((editorFontSize + 2) as 12 | 14 | 16)}
                  className="btn-icon"
                  style={{ width: 'var(--control-height-sm)', height: 'var(--control-height-sm)', borderRadius: 9999, fontSize: 'var(--fs-base)', lineHeight: 1, opacity: editorFontSize >= 16 ? 0.3 : 1, cursor: editorFontSize >= 16 ? 'not-allowed' : 'pointer' }}
                >
                  +
                </button>
              </div>
            </div>
          </div>

          {/* Font Family — full width */}
          <div style={{ marginBottom: 12 }}>
            <label className="subtle" style={{ fontSize: 'var(--fs-base)', display: 'block', marginBottom: 6 }}>{t('settings.fontFamily')}</label>
            <div ref={fontRef} className="relative">
              <button
                type="button"
                onClick={() => setFontOpen((v) => !v)}
                className="btn w-full"
                style={{ padding: 10, borderRadius: 12, fontSize: 'var(--fs-base)', justifyContent: 'space-between' }}
              >
                <span style={{ fontFamily: editorFontFamily }}>{editorFontFamily}</span>
                <ChevronDown size={14} className="subtle" style={{ transform: fontOpen ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s' }} />
              </button>
              {fontOpen && (
                <div className="drop" style={{ left: 0, right: 0 }}>
                  {FONT_FAMILIES.map((font) => (
                    <button
                      type="button"
                      key={font}
                      onClick={() => { setEditorFontFamily(font); setFontOpen(false); }}
                      className="drop-item"
                      style={{
                        fontFamily: font,
                        fontSize: 'var(--fs-base)',
                        background: editorFontFamily === font ? 'var(--c-background-4)' : undefined,
                        color: editorFontFamily === font ? 'var(--c-accent-center-panel)' : undefined,
                      }}
                    >
                      {font}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Default workspace folder */}
          <div style={{ marginBottom: 12 }}>
            <label className="subtle" style={{ fontSize: 'var(--fs-base)', display: 'block', marginBottom: 6 }}>
              {t('settings.defaultFolder')}
            </label>
            <p className="subtle" style={{ fontSize: 'var(--fs-base)', margin: '0 0 8px' }}>
              {t('settings.defaultFolderHint')}
            </p>
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <span
                className="ctrl"
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  display: 'block',
                  fontSize: 'var(--fs-base)',
                  color: defaultFolderPath ? 'var(--c-text-1)' : 'var(--c-text-3)',
                }}
                title={defaultFolderPath ?? undefined}
              >
                {defaultFolderPath ?? t('settings.defaultFolderNone')}
              </span>
              <button
                type="button"
                className="btn"
                style={{ fontSize: 'var(--fs-base)', flexShrink: 0 }}
                onClick={() => void handleChooseDefaultFolder()}
                disabled={!canPickFolder || pickingFolder}
              >
                {defaultFolderPath ? t('settings.defaultFolderChange') : t('settings.defaultFolderChoose')}
              </button>
              {defaultFolderPath && (
                <button
                  type="button"
                  className="btn"
                  style={{ fontSize: 'var(--fs-base)', flexShrink: 0 }}
                  onClick={() => void setDefaultFolderPath(null)}
                  disabled={pickingFolder}
                >
                  {t('settings.defaultFolderClear')}
                </button>
              )}
            </div>
            {!canPickFolder && (
              <p className="subtle" style={{ fontSize: 'var(--fs-base)', marginTop: 6 }}>
                {t('settings.defaultFolderUnavailable')}
              </p>
            )}
          </div>

          {/* Language */}
          <div className="row" style={{ justifyContent: 'space-between', padding: '2px 0' }}>
            <label className="subtle" style={{ fontSize: 'var(--fs-base)' }}>{t('settings.language')}</label>
            <div className="row-xs" style={{ border: '1px solid var(--c-border-1)', borderRadius: 9999, padding: '2px 4px' }}>
              {(['en', 'tr'] as const).map((lang) => (
                <button
                  key={lang}
                  type="button"
                  onClick={() => setLanguage(lang)}
                  className="semibold"
                  style={{
                    padding: '2px 10px',
                    borderRadius: 9999,
                    fontSize: 'var(--fs-base)',
                    border: 'none',
                    cursor: 'pointer',
                    background: language === lang ? 'var(--c-accent-center-panel)' : 'transparent',
                    color: language === lang ? '#fff' : 'var(--c-text-2)',
                    transition: 'background-color 0.15s, color 0.15s',
                  }}
                >
                  {lang.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
