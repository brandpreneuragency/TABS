import { useUIStore } from '../../stores/uiStore';
import { ActionsSection } from './ActionsSection';
import { AppearanceSection } from './AppearanceSection';
import { ToolsSection } from './ToolsSection';
import './settings.css';

export function SettingsDocument() {
  const activeSettingsSubTab = useUIStore((s) => s.activeSettingsSubTab);

  return (
    <div className="settings-document">
      <div className="settings-document-body">
        {activeSettingsSubTab === 'tools' && (
          <ToolsSection />
        )}
        {activeSettingsSubTab === 'actions' && (
          <ActionsSection />
        )}
        {activeSettingsSubTab === 'appearance' && (
          <AppearanceSection />
        )}
      </div>
    </div>
  );
}
