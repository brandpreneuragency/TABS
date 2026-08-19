import type { ReactNode } from 'react';
import { useUIStore } from '../../stores/uiStore';
import { PrimaryWorkspaceContent } from '../layout/workspace';

interface SettingsPanelsProps {
  leftMain?: ReactNode;
  centerMain?: ReactNode;
}

/**
 * Settings left list + center detail for the shared primary workspace shell.
 * Selection / form state stays in parent section components.
 */
export function SettingsPanels({
  leftMain,
  centerMain,
}: SettingsPanelsProps) {
  const contextPanelWidth = useUIStore((s) => s.contextPanelWidth);
  const contextPanelOpen = useUIStore((s) => s.contextPanelOpenByMode.settings);

  const contextPanel = (
    <div className="settings-surface settings-surface--list">
      <div className="settings-surface__body">{leftMain}</div>
    </div>
  );

  const centerPanel = (
    <div className="settings-surface settings-surface--detail">
      <div className="settings-surface__body">{centerMain}</div>
    </div>
  );

  return (
    <PrimaryWorkspaceContent
      mode="settings"
      contextPanel={contextPanel}
      centerPanel={centerPanel}
      contextPanelAvailable
      contextPanelOpen={contextPanelOpen}
      contextPanelWidthVw={contextPanelWidth}
      contextPanelId="settings-list-panel"
      contextPanelClassName="settings-context-column"
      contextPanelStyle={{ backgroundColor: 'var(--c-background-2)' }}
    />
  );
}
